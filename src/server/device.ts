import { DurableObject } from "cloudflare:workers";

import {
  CloseCode,
  DeviceRequest,
  DeviceState,
  ErrorCode,
  type DataChannel,
  type DeviceInfo,
  type PublishOffer,
  type SignalError,
  type ViewerRef,
} from "../proto/cloudflare";
import { debugInfo, errorName, publishOfferSchema, stateName, type Claims } from "../shared/protocol";
import {
  CONTROL_CONFIRM_MS,
  COUNT_GRACE_MS,
  DEVICE_GONE_MS,
  DISCONNECT_GRACE_MS,
  PRESENCE_CHECK_MS,
  UNWATCHED_CHECK_MS,
  WAKE_ATTEMPTS,
  WATCH_LEASE_MS,
  settings,
  type Settings,
} from "./config";
import { deviceChannels, iceServers, RealtimeSfu, SfuError } from "./realtime";
import { claimsFromRequest, jsonError, tableExists, useToken } from "./shared";
import {
  KeyedQueue,
  closeSocket,
  decodeFrame,
  requestName,
  sendDevice,
  signalError,
  upgradeRequired,
} from "./socket";

const SLEEPING = DeviceState.DEVICE_STATE_SLEEPING;
const WAKING = DeviceState.DEVICE_STATE_WAKING;
const LIVE = DeviceState.DEVICE_STATE_LIVE;

/** The publishing state that survives hibernation. Offline is computed from the socket. */
type PublishState = typeof SLEEPING | typeof WAKING | typeof LIVE;

type DeviceRow = {
  state: PublishState;
  generation: number;
  wake_deadline: number | null;
  wake_attempts: number;
  sfu_session_id: string | null;
  tracks: string;
  /** The device's _lossy and _reliable, as DataChannel[] JSON. */
  channels: string;
  rooms: string;
  linger_until: number | null;
  last_error: ErrorCode;
  last_seen: number;
  disconnected_at: number | null;
  offline_notified: number;
};

type SocketAttachment = { connectedAt: number };

export type WatchResult = { member: boolean; info: DeviceInfo };

export type ResolveResult =
  | { ok: true; sessionId: string; generation: number; tracks: string[]; dataChannels: boolean; canReply: boolean }
  | { ok: false; code: ErrorCode; message: string };

export type ControlResult = { ok: true } | { ok: false; code: ErrorCode; message: string };

/** Who may send to the device through its data channels. Survives new publications. */
type ControlState = {
  controller: ViewerRef | null;
  /** Handed control; has until `deadline` to confirm with control_ready. */
  handover: (ViewerRef & { deadline: number }) | null;
  /** In line, first one next. */
  waiting: ViewerRef[];
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS device (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    wake_deadline INTEGER,
    wake_attempts INTEGER NOT NULL,
    sfu_session_id TEXT,
    tracks TEXT NOT NULL,
    channels TEXT NOT NULL,
    rooms TEXT NOT NULL,
    linger_until INTEGER,
    last_error INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    disconnected_at INTEGER,
    offline_notified INTEGER NOT NULL
  );
  -- Rooms that have viewers interested in this device. A room renews its row while it has viewers.
  CREATE TABLE IF NOT EXISTS watching_rooms (
    room_id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  -- Viewers that receive the device's tracks or data channels. The viewer limit counts these rows.
  CREATE TABLE IF NOT EXISTS room_viewers (
    room_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    counted_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, viewer_id)
  ) WITHOUT ROWID;
  -- Who controls the device through its data channels, who takes over, who waits (one row).
  CREATE TABLE IF NOT EXISTS control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL
  );
  -- Access tokens are single use.
  CREATE TABLE IF NOT EXISTS used_tokens (
    jti TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) WITHOUT ROWID;
`;

/**
 * One instance per device_id. Owns the device's socket and presence, its SFU publisher session,
 * and when the device should publish: it sends `wake` when a room starts watching and `sleep`
 * once no room has watched for IDLE_LINGER_SECONDS.
 */
export class Device extends DurableObject<Env> {
  private readonly config: Settings;
  private readonly queue = new KeyedQueue();
  /** Tables exist from the first connection until the device has left every room and is forgotten. */
  private ready: boolean;
  /** The SFU session started together with `wake`, so the offer needs one SFU call instead of two. */
  private earlySession: Promise<string | null> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = settings(env);
    // Devices send "ping" every 15 s. The runtime answers without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ready = tableExists(ctx.storage.sql, "device");
    // A deploy drops the socket without a close event. Hibernation keeps it, so no socket here
    // means it is gone: count the device as disconnected from now, so it has the usual grace
    // time to reconnect before viewers see it offline.
    if (this.ready && ctx.getWebSockets().length === 0) {
      ctx.storage.sql.exec("UPDATE device SET disconnected_at = ? WHERE disconnected_at IS NULL", Date.now());
      // No alarm may be set, e.g. it was connected and nobody watched it. Without one it would
      // never go offline or leave its rooms.
      void ctx.blockConcurrencyWhile(() => this.scheduleAlarm(Date.now()));
    }
  }

  private get deviceId(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("Device must be addressed by name.");
    return name;
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  // -------------------------------------------------------------------------
  // Socket
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (upgradeRequired(request)) return jsonError(426, "upgrade_required", "Open a WebSocket.");
    const claims = claimsFromRequest(request);
    if (!claims || claims.sub !== this.deviceId || !claims.grant.canPublish) {
      return jsonError(400, "claims_invalid", "The token does not match this device.");
    }
    if (!this.ready) {
      this.sql.exec(SCHEMA);
      this.ready = true;
    }
    const now = Date.now();
    if (!useToken(this.sql, claims, now)) {
      return jsonError(401, "token_used", "The access token was already used. Request a new one.");
    }

    let row = this.row() ?? this.createRow(now);

    // A newer connection always wins. The old client stops reconnecting when it gets REPLACED.
    for (const old of this.ctx.getWebSockets()) {
      console.log(JSON.stringify({ event: "device_replaced", deviceId: this.deviceId }));
      closeSocket(old, CloseCode.CLOSE_CODE_REPLACED, "Another connection uses the same device_id.");
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connectedAt: now } satisfies SocketAttachment);

    const { errors: roomErrors, left } = await this.updateRooms(row, claims, now);
    if (left.length > 0) await this.queue.run("control", () => this.removeFromControl((ref) => left.includes(ref.room)));
    row = this.row()!;

    // Keep the publication only when the same publisher reconnects its socket: it sends the
    // generation of the answer its PeerConnection uses.
    const continuing =
      (row.state === WAKING || row.state === LIVE) &&
      row.sfu_session_id !== null &&
      claims.grant.generation === row.generation;
    if (!continuing && row.state !== SLEEPING) this.resetPublication(row);

    row.last_seen = now;
    row.disconnected_at = null;
    row.offline_notified = 0;
    this.save(row);

    // `joined` comes first: the device needs its ICE servers before a wake.
    sendDevice(server, {
      joined: {
        deviceId: this.deviceId,
        state: row.state,
        generation: row.generation,
        rooms: this.rooms(row),
        iceServers: await iceServers(this.env),
      },
    });
    for (const error of roomErrors) sendDevice(server, { error });
    // A device that reconnects while publishing may have missed changes.
    const channels = JSON.parse(row.channels) as DataChannel[];
    if (channels.length > 0) sendDevice(server, { channels: { channels } });
    const { controller } = this.control();
    if (controller) sendDevice(server, { control: { controller } });
    if (this.hasWatchers(now) && row.state === SLEEPING) this.startWake(server, now);

    void this.notifyRoomsSoon();
    await this.scheduleAlarm(now);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    // A replaced socket is closing: what it still sends belongs to the old connection.
    if (ws.readyState !== WebSocket.OPEN) return;
    const request = decodeFrame(DeviceRequest, data);
    const { offer, ready } = request ?? {};
    if (offer) {
      await this.queue.run("publish", () => this.onOffer(ws, offer));
    } else if (ready) {
      await this.queue.run("publish", () => this.onReady(ws));
    } else {
      const name = request ? requestName(request) : "";
      this.fail(ws, ErrorCode.ERROR_CODE_INVALID_MESSAGE, "Send a binary DeviceRequest with offer or ready.", name);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.onSocketGone(ws, code);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  private async onSocketGone(ws: WebSocket, code?: number): Promise<void> {
    console.log(JSON.stringify({ event: "device_socket_closed", deviceId: this.deviceId, code: code ?? null }));
    if (this.ctx.getWebSockets().some((other) => other !== ws)) return; // replaced, not gone
    const row = this.row();
    if (!row) return;
    const now = Date.now();
    // A heartbeat timeout already set it to the last ping.
    row.disconnected_at ??= now;
    if (code === 1000 || code === 1001) {
      // The device closed on purpose, e.g. it shut down or changed its ID.
      await this.leaveRooms(row);
    } else {
      this.save(row);
    }
    await this.scheduleAlarm(now);
  }

  /**
   * The device closed its socket on purpose, or sent nothing for DEVICE_GONE_MS. It leaves its
   * rooms, so viewers do not keep an offline tile for it. It joins them again when it reconnects.
   */
  private async leaveRooms(row: DeviceRow): Promise<void> {
    const rooms = this.rooms(row);
    this.resetPublication(row);
    row.rooms = "[]";
    row.offline_notified = 1;
    this.save(row);
    this.forgetWatch();
    await this.queue.run("control", () => this.removeFromControl(() => true));
    await Promise.allSettled(rooms.map((room) => this.env.ROOMS.getByName(room).removeMember(this.deviceId)));
  }

  private async onOffer(ws: WebSocket, message: PublishOffer): Promise<void> {
    const parsed = publishOfferSchema.safeParse(message);
    if (!parsed.success) {
      this.fail(ws, ErrorCode.ERROR_CODE_INVALID_MESSAGE, "The offer needs sdp and tracks.", "offer");
      return;
    }
    const { sdp, tracks, dataChannels } = parsed.data;
    // Any offer while waking or live will do, even one sent before the latest wake: it comes
    // from the same device, which uses only the reply to its last offer.
    const before = this.row();
    if (!before || before.state === SLEEPING) {
      this.fail(ws, ErrorCode.ERROR_CODE_WAKE_STALE, "The device was put to sleep.", "offer");
      return;
    }

    try {
      const sfu = new RealtimeSfu(this.env);
      const local = tracks.map((track) => ({ location: "local" as const, mid: track.mid, trackName: track.trackName }));
      const early = await this.takeEarlySession();
      let sessionId = early ?? (await sfu.createSession());
      let result;
      try {
        result = await sfu.addTracks(sessionId, local, { type: "offer", sdp });
      } catch (error) {
        // A session made at wake time can expire if the offer comes late. Start a new one.
        if (!(early && error instanceof SfuError && error.sessionGone)) throw error;
        sessionId = await sfu.createSession();
        result = await sfu.addTracks(sessionId, local, { type: "offer", sdp });
      }
      const failed = result.tracks?.find((track) => track.errorCode);
      if (failed) {
        throw new SfuError(failed.errorCode!, failed.errorDescription ?? `The SFU rejected ${failed.trackName}.`, 502);
      }
      if (result.sessionDescription?.type !== "answer") {
        throw new SfuError("sfu_answer_missing", "The SFU did not answer the offer.", 502);
      }

      // The device may have been put to sleep while the SFU call was running.
      const row = this.row();
      if (!row || row.state === SLEEPING) {
        this.fail(ws, ErrorCode.ERROR_CODE_WAKE_STALE, "The device was put to sleep.", "offer");
        return;
      }
      // The device is live once it says its PeerConnection is connected ("ready"). Until then
      // the SFU has no packets for these tracks, and viewers would get not_found_track_error.
      const now = Date.now();
      row.state = WAKING;
      row.generation += 1;
      row.sfu_session_id = sessionId;
      row.tracks = JSON.stringify(tracks.map((track) => track.trackName));
      row.wake_deadline = now + this.config.wakeTimeoutMs;
      row.last_error = ErrorCode.ERROR_CODE_UNSPECIFIED;
      row.last_seen = now;
      this.save(row);

      sendDevice(ws, { answer: { generation: row.generation, sdp: result.sessionDescription.sdp } });
      if (!this.hasWatchers(now)) this.startLinger(now);
      void this.notifyRoomsSoon();
      await this.scheduleAlarm(now);
      // The SFU answers this once the device's PeerConnection is connected. The device's
      // ready waits behind it in the queue, so the device goes live with its channels.
      if (dataChannels) await this.openChannels(ws, sessionId);
    } catch (error) {
      const code = error instanceof SfuError ? error.code : "publish_failed";
      const text = error instanceof Error ? error.message : "Publishing failed.";
      console.log(JSON.stringify({ event: "publish_failed", deviceId: this.deviceId, code }));
      this.fail(ws, ErrorCode.ERROR_CODE_SFU, `${code}: ${text}`, "offer");
    }
  }

  /** Publishes _lossy and _reliable on the device's session and sends their ids. */
  private async openChannels(ws: WebSocket, sessionId: string): Promise<void> {
    let channels: DataChannel[];
    try {
      channels = await new RealtimeSfu(this.env).addDataChannels(sessionId, deviceChannels("local"));
    } catch (error) {
      const code = error instanceof SfuError ? error.code : "data_channels_failed";
      console.log(JSON.stringify({ event: "data_channels_failed", deviceId: this.deviceId, code }));
      this.fail(ws, ErrorCode.ERROR_CODE_NO_DATA_CHANNELS, `${code}: the data channels did not open. Video still works.`, "offer");
      return;
    }
    const row = this.row();
    if (!row || row.sfu_session_id !== sessionId) return;
    row.channels = JSON.stringify(channels);
    this.save(row);
    sendDevice(ws, { channels: { channels } });
    if (row.state === LIVE) void this.notifyRoomsSoon();
  }

  private async onReady(ws: WebSocket): Promise<void> {
    const row = this.row();
    if (!row) return;
    if (row.state === SLEEPING) {
      // This publication ended while the device was not looking, e.g. its wake timed out.
      sendDevice(ws, { sleep: {} });
      return;
    }
    // Waking with no answer yet: the wake went out after this ready, and the device starts over.
    if (!row.sfu_session_id || row.state === LIVE) return;
    const now = Date.now();
    row.state = LIVE;
    row.wake_deadline = null;
    row.wake_attempts = 0;
    row.last_error = ErrorCode.ERROR_CODE_UNSPECIFIED;
    this.save(row);
    void this.notifyRoomsSoon();
    await this.scheduleAlarm(now);
  }

  // -------------------------------------------------------------------------
  // RPC from Room
  // -------------------------------------------------------------------------

  /**
   * A room has viewers. Records the interest, wakes the device and returns its state. `viewers`
   * are the room's viewers that receive this device. Rows of other viewers are removed, unless
   * they were counted so recently that their subscribe may still be running.
   */
  async watch(roomId: string, viewers: string[]): Promise<WatchResult> {
    const now = Date.now();
    const row = this.row();
    if (!row || !this.rooms(row).includes(roomId)) {
      return { member: false, info: this.info(now) };
    }
    this.setWatching(roomId, now);
    this.sql.exec(
      "DELETE FROM room_viewers WHERE room_id = ? AND counted_at < ? AND viewer_id NOT IN (SELECT value FROM json_each(?))",
      roomId,
      now - COUNT_GRACE_MS,
      JSON.stringify(viewers),
    );
    if (row.linger_until !== null) {
      row.linger_until = null;
      this.save(row);
    }
    const ws = this.socket();
    if (row.state === SLEEPING && ws && this.isOnline(now)) {
      this.startWake(ws, now);
      // The asking room gets the new state in the reply.
      void this.notifyRoomsSoon(roomId);
    }
    await this.scheduleAlarm(now);
    return { member: true, info: this.info(now) };
  }

  /** A room has no viewers left. */
  async unwatch(roomId: string): Promise<void> {
    if (!this.ready) return;
    const now = Date.now();
    this.forgetWatch(roomId);
    const row = this.row();
    if (row && row.state !== SLEEPING && !this.hasWatchers(now)) this.startLinger(now);
    await this.scheduleAlarm(now);
  }

  /** A viewer gets nothing from this device any more, so it stops counting toward the limit. */
  async release(roomId: string, viewerId: string): Promise<void> {
    if (!this.ready) return;
    this.sql.exec("DELETE FROM room_viewers WHERE room_id = ? AND viewer_id = ?", roomId, viewerId);
  }

  /**
   * Gives a room what it needs to pull this device's tracks, if the viewer limit allows, and counts
   * the viewer. The check and the count happen in one step, so viewers asking at once queue here.
   */
  async resolve(roomId: string, viewerId: string): Promise<ResolveResult> {
    const now = Date.now();
    const row = this.row();
    if (!row || !this.rooms(row).includes(roomId)) {
      return { ok: false, code: ErrorCode.ERROR_CODE_NOT_MEMBER, message: `${this.deviceId} is not in room ${roomId}.` };
    }
    if (row.state !== LIVE || !row.sfu_session_id || !this.isOnline(now)) {
      return { ok: false, code: ErrorCode.ERROR_CODE_NOT_LIVE, message: `${this.deviceId} is not publishing.` };
    }
    const counted = this.sql
      .exec("SELECT 1 FROM room_viewers WHERE room_id = ? AND viewer_id = ?", roomId, viewerId)
      .toArray().length > 0;
    if (!counted && this.viewerTotal(now) >= this.config.maxViewersPerDevice) {
      return {
        ok: false,
        code: ErrorCode.ERROR_CODE_VIEWER_LIMIT,
        message: `${this.deviceId} already has ${this.config.maxViewersPerDevice} viewers.`,
      };
    }
    this.setWatching(roomId, now);
    this.sql.exec(
      "INSERT OR REPLACE INTO room_viewers (room_id, viewer_id, counted_at) VALUES (?, ?, ?)",
      roomId,
      viewerId,
      now,
    );
    const { controller, handover } = this.control();
    const me = { room: roomId, viewerId };
    return {
      ok: true,
      sessionId: row.sfu_session_id,
      generation: row.generation,
      tracks: JSON.parse(row.tracks),
      dataChannels: (JSON.parse(row.channels) as DataChannel[]).length > 0,
      canReply: sameViewer(controller, me) || sameViewer(handover, me),
    };
  }

  // -------------------------------------------------------------------------
  // Control: one viewer at a time can send to the device (the SFU's canReply)
  // -------------------------------------------------------------------------

  /** Controls the device if nobody does, or waits in line. */
  async takeControl(roomId: string, viewerId: string): Promise<ControlResult> {
    return this.queue.run("control", async () => {
      const row = this.row();
      if (!row || !this.rooms(row).includes(roomId)) {
        return { ok: false, code: ErrorCode.ERROR_CODE_NOT_MEMBER, message: `${this.deviceId} is not in room ${roomId}.` };
      }
      const control = this.control();
      const me = { room: roomId, viewerId };
      if ([control.controller, control.handover, ...control.waiting].some((ref) => sameViewer(ref, me))) {
        return { ok: true };
      }
      if (control.controller || control.handover) control.waiting.push(me);
      else control.handover = { ...me, deadline: Date.now() + CONTROL_CONFIRM_MS };
      await this.saveControl(control);
      return { ok: true };
    });
  }

  /** Gives up control, a takeover or a place in line. The first one waiting takes over. */
  async releaseControl(roomId: string, viewerId: string): Promise<ControlResult> {
    return this.queue.run("control", async () => {
      const found = await this.removeFromControl((ref) => sameViewer(ref, { room: roomId, viewerId }));
      if (found) return { ok: true };
      return { ok: false, code: ErrorCode.ERROR_CODE_NOT_CONTROLLER, message: `You do not control or wait for ${this.deviceId}.` };
    });
  }

  /** The viewer handed control has canReply and open channels, so the takeover is done. */
  async confirmControl(roomId: string, viewerId: string): Promise<ControlResult> {
    return this.queue.run("control", async () => {
      if (!this.ready) {
        return { ok: false, code: ErrorCode.ERROR_CODE_NOT_CONTROLLER, message: `${this.deviceId} is not being handed to you.` };
      }
      const control = this.control();
      const me = { room: roomId, viewerId };
      if (sameViewer(control.controller, me)) return { ok: true };
      if (!sameViewer(control.handover, me)) {
        return { ok: false, code: ErrorCode.ERROR_CODE_NOT_CONTROLLER, message: `${this.deviceId} is not being handed to you.` };
      }
      control.controller = me;
      control.handover = null;
      await this.saveControl(control);
      return { ok: true };
    });
  }

  /** The viewer closed the device's channels or left its room. */
  async controlGone(roomId: string, viewerId: string): Promise<void> {
    if (!this.ready) return;
    await this.queue.run("control", () => this.removeFromControl((ref) => sameViewer(ref, { room: roomId, viewerId })));
  }

  async getInfo(): Promise<DeviceInfo> {
    return this.info(Date.now());
  }

  /** Everything this object holds, for the local debug page. Includes the SFU session ID. */
  async debugState() {
    const now = Date.now();
    const row = this.row();
    return {
      deviceId: this.deviceId,
      now,
      info: debugInfo(this.info(now)),
      online: this.isOnline(now),
      row: row
        ? {
            ...row,
            state: stateName(row.state),
            last_error: row.last_error ? errorName(row.last_error) : null,
            tracks: JSON.parse(row.tracks) as string[],
            channels: JSON.parse(row.channels) as DataChannel[],
            rooms: this.rooms(row),
          }
        : null,
      control: this.ready ? this.control() : null,
      watchingRooms: this.ready
        ? this.sql
            .exec<{ room_id: string; expires_at: number }>("SELECT * FROM watching_rooms ORDER BY room_id")
            .toArray()
            .map((room) => ({
              ...room,
              viewers: this.sql
                .exec<{ viewer_id: string }>("SELECT viewer_id FROM room_viewers WHERE room_id = ? ORDER BY counted_at", room.room_id)
                .toArray()
                .map((viewer) => viewer.viewer_id),
            }))
        : [],
      sockets: this.ctx.getWebSockets().map((ws) => ({
        readyState: ws.readyState,
        connectedAt: (ws.deserializeAttachment() as SocketAttachment | null)?.connectedAt ?? null,
        lastPing: this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null,
      })),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  // -------------------------------------------------------------------------
  // Alarm
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    const now = Date.now();
    let row = this.row();
    if (!row) return;
    this.sql.exec("DELETE FROM watching_rooms WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM room_viewers WHERE room_id NOT IN (SELECT room_id FROM watching_rooms)");
    this.sql.exec("DELETE FROM used_tokens WHERE expires_at <= ?", now);

    const ws = this.socket();
    if (ws && now - this.lastSeen(ws) > this.config.deviceStaleMs) {
      // Half-open connection: the socket exists but pings stopped.
      console.log(JSON.stringify({ event: "device_stale", deviceId: this.deviceId, silentMs: now - this.lastSeen(ws) }));
      closeSocket(ws, CloseCode.CLOSE_CODE_HEARTBEAT_TIMEOUT, "No ping received.");
      // The device has been silent since its last ping, so the grace time is already over.
      row.disconnected_at ??= this.lastSeen(ws);
    }

    const online = this.isOnline(now);
    let changed = false;
    let timedOut = false;

    if (!online && !row.offline_notified && this.disconnectGraceOver(row, now)) {
      row.offline_notified = 1;
      changed = true;
    }

    // Dropped without a close, e.g. the process was killed, and not back within a minute.
    if (!this.socket() && row.disconnected_at !== null && now - row.disconnected_at >= DEVICE_GONE_MS && this.rooms(row).length > 0) {
      console.log(JSON.stringify({ event: "device_gone", deviceId: this.deviceId, silentMs: now - row.disconnected_at }));
      await this.leaveRooms(row);
    }

    if (row.state === WAKING && row.wake_deadline !== null && row.wake_deadline <= now) {
      const current = this.socket();
      if (online && current && row.wake_attempts < WAKE_ATTEMPTS) {
        // The device starts over with a new PeerConnection.
        row.wake_attempts += 1;
        row.wake_deadline = now + this.config.wakeTimeoutMs;
        sendDevice(current, { wake: {} });
      } else {
        this.resetPublication(row);
        row.last_error = ErrorCode.ERROR_CODE_WAKE_TIMEOUT;
        changed = true;
        timedOut = true;
      }
    }

    if (row.linger_until !== null && row.linger_until <= now) {
      row.linger_until = null;
      if (!this.hasWatchers(now)) {
        const current = this.socket();
        if (current) sendDevice(current, { sleep: {} });
        this.resetPublication(row);
        changed = true;
      }
    }
    this.save(row);

    // Rooms are still watching but the device is not publishing. Try again on the next check,
    // so viewers see the timeout first.
    const current = this.socket();
    if (!timedOut && this.hasWatchers(now) && row.state === SLEEPING && online && current) {
      this.startWake(current, now);
      changed = true;
    }

    if (changed) await this.notifyRoomsSoon();

    const expired = await this.queue.run("control", () => this.expireHandover(now));
    // Outside the control queue: the room may be waiting on this object for the same viewer.
    if (expired) {
      void this.env.ROOMS.getByName(expired.room)
        .revokeControl(this.deviceId, expired.viewerId, true)
        .catch(() => undefined);
    }

    row = this.row()!;
    // Gone from every room: nothing here is needed any more, once no used token can come back.
    if (!this.socket() && this.rooms(row).length === 0 && this.tokensExpireAt() === null) {
      await this.ctx.storage.deleteAll();
      this.ready = false;
      return;
    }
    await this.scheduleAlarm(now);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private fail(ws: WebSocket, code: ErrorCode, message: string, request: string): void {
    sendDevice(ws, { error: signalError({ code, message, request }) });
  }

  private row(): DeviceRow | null {
    if (!this.ready) return null;
    return this.sql.exec<DeviceRow>("SELECT * FROM device WHERE id = 1").toArray()[0] ?? null;
  }

  private createRow(now: number): DeviceRow {
    const row: DeviceRow = {
      state: SLEEPING,
      generation: 0,
      wake_deadline: null,
      wake_attempts: 0,
      sfu_session_id: null,
      tracks: "[]",
      channels: "[]",
      rooms: "[]",
      linger_until: null,
      last_error: ErrorCode.ERROR_CODE_UNSPECIFIED,
      last_seen: now,
      disconnected_at: null,
      offline_notified: 0,
    };
    this.save(row);
    return row;
  }

  private save(row: DeviceRow): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO device (id, state, generation, wake_deadline, wake_attempts,
         sfu_session_id, tracks, channels, rooms, linger_until, last_error, last_seen, disconnected_at, offline_notified)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.state,
      row.generation,
      row.wake_deadline,
      row.wake_attempts,
      row.sfu_session_id,
      row.tracks,
      row.channels,
      row.rooms,
      row.linger_until,
      row.last_error,
      row.last_seen,
      row.disconnected_at,
      row.offline_notified,
    );
  }

  private rooms(row: DeviceRow): string[] {
    return JSON.parse(row.rooms) as string[];
  }

  /** Joins the rooms in the token and leaves the rooms that are no longer in it. */
  private async updateRooms(row: DeviceRow, claims: Claims, now: number): Promise<{ errors: SignalError[]; left: string[] }> {
    const wanted = [...new Set(claims.grant.rooms)];
    const previous = this.rooms(row);
    const errors: SignalError[] = [];
    const joined: string[] = [];

    const results = await Promise.allSettled(
      wanted.map((room) => this.env.ROOMS.getByName(room).addMember(this.deviceId)),
    );
    results.forEach((result, index) => {
      const room = wanted[index]!;
      if (result.status === "fulfilled" && result.value.ok) {
        joined.push(room);
        if (result.value.viewers > 0) this.setWatching(room, now);
      } else if (result.status === "fulfilled" && !result.value.ok) {
        errors.push(signalError({ code: result.value.code, message: result.value.message }));
      } else {
        errors.push(signalError({ code: ErrorCode.ERROR_CODE_ROOM_UNAVAILABLE, message: `Could not join room ${room}.` }));
      }
    });

    const left = previous.filter((room) => !joined.includes(room));
    await Promise.allSettled(left.map((room) => this.env.ROOMS.getByName(room).removeMember(this.deviceId)));
    for (const room of left) this.forgetWatch(room);

    row.rooms = JSON.stringify(joined);
    this.save(row);
    return { errors, left };
  }

  private setWatching(roomId: string, now: number): void {
    this.sql.exec("INSERT OR REPLACE INTO watching_rooms (room_id, expires_at) VALUES (?, ?)", roomId, now + WATCH_LEASE_MS);
  }

  /** Forgets one room's interest and its viewers, or every room's. */
  private forgetWatch(roomId?: string): void {
    if (roomId === undefined) {
      this.sql.exec("DELETE FROM watching_rooms");
      this.sql.exec("DELETE FROM room_viewers");
    } else {
      this.sql.exec("DELETE FROM watching_rooms WHERE room_id = ?", roomId);
      this.sql.exec("DELETE FROM room_viewers WHERE room_id = ?", roomId);
    }
  }

  /** Viewers counted across every room that still watches. */
  private viewerTotal(now: number): number {
    return this.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM room_viewers WHERE room_id IN (SELECT room_id FROM watching_rooms WHERE expires_at > ?)",
        now,
      )
      .one().n;
  }

  private watchingRooms(now: number): string[] {
    if (!this.ready) return [];
    return this.sql
      .exec<{ room_id: string }>("SELECT room_id FROM watching_rooms WHERE expires_at > ?", now)
      .toArray()
      .map((row) => row.room_id);
  }

  private hasWatchers(now: number): boolean {
    return this.watchingRooms(now).length > 0;
  }

  private startWake(ws: WebSocket, now: number): void {
    const row = this.row()!;
    row.state = WAKING;
    row.wake_deadline = now + this.config.wakeTimeoutMs;
    row.wake_attempts = 1;
    row.linger_until = null;
    row.last_error = ErrorCode.ERROR_CODE_UNSPECIFIED;
    this.save(row);
    sendDevice(ws, { wake: {} });
    // The device needs a moment to build its offer. Create the SFU session meanwhile.
    this.earlySession = new RealtimeSfu(this.env).createSession().catch(() => null);
  }

  /** The session started with this wake, or null when there is none (a retry, or the object restarted). */
  private async takeEarlySession(): Promise<string | null> {
    const early = this.earlySession;
    this.earlySession = null;
    return early ? await early : null;
  }

  private startLinger(now: number): void {
    const row = this.row();
    if (!row || row.linger_until !== null) return;
    row.linger_until = now + this.config.idleLingerMs;
    this.save(row);
  }

  /**
   * Forgets the current publication. The generation stays: it counts publications and goes up
   * only with the next offer. Viewers drop their tracks because the state is no longer live.
   */
  private resetPublication(row: DeviceRow): void {
    row.state = SLEEPING;
    row.wake_deadline = null;
    row.wake_attempts = 0;
    row.sfu_session_id = null;
    row.tracks = "[]";
    row.channels = "[]";
    row.linger_until = null;
    this.earlySession = null;
  }

  private socket(): WebSocket | null {
    const sockets = this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
    return sockets[sockets.length - 1] ?? null;
  }

  private lastSeen(ws: WebSocket): number {
    const pong = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    return Math.max(pong, attachment?.connectedAt ?? 0);
  }

  /** When the last used token may be forgotten, or null when none is kept. */
  private tokensExpireAt(): number | null {
    return this.sql.exec<{ at: number | null }>("SELECT MAX(expires_at) AS at FROM used_tokens").one().at;
  }

  private isOnline(now: number): boolean {
    const ws = this.socket();
    return ws !== null && now - this.lastSeen(ws) <= this.config.deviceStaleMs;
  }

  private disconnectGraceOver(row: DeviceRow, now: number): boolean {
    return row.disconnected_at === null || now - row.disconnected_at >= DISCONNECT_GRACE_MS;
  }

  private info(now: number): DeviceInfo {
    const row = this.row();
    if (!row) {
      return {
        deviceId: this.deviceId,
        state: DeviceState.DEVICE_STATE_OFFLINE,
        generation: 0,
        tracks: [],
        lastError: ErrorCode.ERROR_CODE_UNSPECIFIED,
        dataChannels: false,
        controller: undefined,
        handover: undefined,
        waiting: [],
      };
    }
    const online = this.isOnline(now) || (row.disconnected_at !== null && !this.disconnectGraceOver(row, now));
    const live = online && row.state === LIVE;
    const control = this.control();
    return {
      deviceId: this.deviceId,
      state: online ? row.state : DeviceState.DEVICE_STATE_OFFLINE,
      generation: row.generation,
      tracks: live ? (JSON.parse(row.tracks) as string[]) : [],
      lastError: row.last_error,
      dataChannels: live && (JSON.parse(row.channels) as DataChannel[]).length > 0,
      controller: control.controller ?? undefined,
      handover: control.handover ? { room: control.handover.room, viewerId: control.handover.viewerId } : undefined,
      waiting: control.waiting,
    };
  }

  private control(): ControlState {
    const state = this.sql.exec<{ state: string }>("SELECT state FROM control WHERE id = 1").toArray()[0]?.state;
    return state ? (JSON.parse(state) as ControlState) : { controller: null, handover: null, waiting: [] };
  }

  /**
   * Stores the control state, tells the device when the controller changed, and tells the rooms.
   * A new handover asks the viewer's room to grant canReply, outside the control queue.
   */
  private async saveControl(control: ControlState): Promise<void> {
    const before = this.control();
    this.sql.exec("INSERT OR REPLACE INTO control (id, state) VALUES (1, ?)", JSON.stringify(control));
    if (!sameViewer(before.controller, control.controller) && (before.controller || control.controller)) {
      console.log(JSON.stringify({ event: "control_changed", deviceId: this.deviceId, controller: control.controller }));
      const ws = this.socket();
      if (ws) sendDevice(ws, { control: { controller: control.controller ?? undefined } });
    }
    if (control.handover && !sameViewer(before.handover, control.handover)) void this.offerControl(control.handover);
    void this.notifyRoomsSoon();
    await this.scheduleAlarm(Date.now());
  }

  /** Takes matching viewers out of the control state. The first one waiting takes over if needed. */
  private async removeFromControl(match: (ref: ViewerRef) => boolean): Promise<boolean> {
    if (!this.ready) return false;
    const control = this.control();
    const before = JSON.stringify(control);
    control.waiting = control.waiting.filter((ref) => !match(ref));
    if (control.controller && match(control.controller)) control.controller = null;
    if (control.handover && match(control.handover)) control.handover = null;
    if (JSON.stringify(control) === before) return false;
    if (!control.controller && !control.handover) this.handOverToNext(control);
    await this.saveControl(control);
    return true;
  }

  private handOverToNext(control: ControlState): void {
    const next = control.waiting.shift();
    if (next) control.handover = { ...next, deadline: Date.now() + CONTROL_CONFIRM_MS };
  }

  /** Asks the viewer's room to grant canReply. A viewer that cannot take it is skipped at once. */
  private async offerControl(to: ViewerRef): Promise<void> {
    const granted = await this.env.ROOMS.getByName(to.room)
      .grantControl(this.deviceId, to.viewerId)
      .catch(() => false);
    if (granted) return;
    await this.queue.run("control", () => this.removeFromControl((ref) => sameViewer(ref, to)));
  }

  /** A handover that was not confirmed in time goes to the next one waiting. Returns who timed out. */
  private async expireHandover(now: number): Promise<ViewerRef | null> {
    const control = this.control();
    const handover = control.handover;
    if (!handover || handover.deadline > now) return null;
    console.log(JSON.stringify({ event: "control_timeout", deviceId: this.deviceId, viewer: handover }));
    control.handover = null;
    this.handOverToNext(control);
    await this.saveControl(control);
    return { room: handover.room, viewerId: handover.viewerId };
  }

  /**
   * Tells the watching rooms about the current state without holding up the caller, so the
   * device can go on with its offer while the rooms update. Updates go out one at a time and each
   * reads the state when it starts, so every room ends on the latest state.
   */
  private notifyRoomsSoon(exceptRoom?: string): Promise<void> {
    return this.queue.run("notify", async () => {
      if (this.ready) await this.notifyRooms(Date.now(), exceptRoom);
    });
  }

  /** Tells every watching room about the current state, except the room that asked. */
  private async notifyRooms(now: number, exceptRoom?: string): Promise<void> {
    const info = this.info(now);
    const rooms = this.watchingRooms(now).filter((room) => room !== exceptRoom);
    const results = await Promise.allSettled(
      rooms.map((room) => this.env.ROOMS.getByName(room).deviceChanged(this.deviceId, info)),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled" && !result.value.watching) {
        this.forgetWatch(rooms[index]!);
      }
    });
  }

  private async scheduleAlarm(now: number): Promise<void> {
    const row = this.row();
    if (!row) return;
    const candidates: number[] = [];
    if (row.wake_deadline !== null) candidates.push(row.wake_deadline);
    if (row.linger_until !== null) candidates.push(row.linger_until);
    const { handover } = this.control();
    if (handover) candidates.push(handover.deadline);
    const ws = this.socket();
    if (this.hasWatchers(now)) {
      // Check again when the last ping turns stale, so a silent device shows offline about
      // DEVICE_STALE_SECONDS after its last ping instead of up to a full check interval later.
      const stale = ws ? this.lastSeen(ws) + this.config.deviceStaleMs + 1000 : Infinity;
      candidates.push(Math.min(now + PRESENCE_CHECK_MS, stale));
    } else if (ws) {
      candidates.push(now + UNWATCHED_CHECK_MS);
    }
    const lease = this.sql
      .exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM watching_rooms")
      .one().next;
    if (lease !== null) candidates.push(lease);
    if (!ws) {
      if (row.disconnected_at !== null && !row.offline_notified) {
        candidates.push(row.disconnected_at + DISCONNECT_GRACE_MS);
      }
      if (this.rooms(row).length > 0) {
        if (row.disconnected_at !== null) candidates.push(row.disconnected_at + DEVICE_GONE_MS);
      } else {
        // Forget the device once the tokens it used have expired.
        candidates.push(this.tokensExpireAt() ?? now);
      }
    }
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), now + 1000));
  }
}

function sameViewer(a: ViewerRef | null | undefined, b: ViewerRef | null | undefined): boolean {
  return !!a && !!b && a.room === b.room && a.viewerId === b.viewerId;
}
