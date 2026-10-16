import { DurableObject } from "cloudflare:workers";

import {
  CLOSE_HEARTBEAT_TIMEOUT,
  CLOSE_REPLACED,
  offerMessageSchema,
  readyMessageSchema,
  unpublishedMessageSchema,
  type Claims,
  type DeviceInfo,
  type DeviceState,
} from "../shared/protocol";
import {
  DEVICE_RETENTION_MS,
  DISCONNECT_GRACE_MS,
  PRESENCE_CHECK_MS,
  WAKE_ATTEMPTS,
  WATCH_LEASE_MS,
  settings,
  type Settings,
} from "./config";
import { iceServers, RealtimeSfu, SfuError } from "./realtime";
import { claimsFromRequest, jsonError, tableExists, useToken } from "./shared";
import { KeyedQueue, closeSocket, parseIncoming, send, sendError, upgradeRequired } from "./socket";

/** The publishing state that survives hibernation. `offline` is computed from the socket. */
type PublishState = Exclude<DeviceState, "offline">;

type DeviceRow = {
  state: PublishState;
  generation: number;
  wake_id: string | null;
  wake_deadline: number | null;
  wake_attempts: number;
  sfu_session_id: string | null;
  tracks: string;
  rooms: string;
  linger_until: number | null;
  last_error: string | null;
  last_seen: number;
  disconnected_at: number | null;
  offline_notified: number;
};

type SocketAttachment = { connectedAt: number };

export type WatchResult = { member: boolean; info: DeviceInfo };

export type ResolveResult =
  | { ok: true; sessionId: string; generation: number; tracks: string[] }
  | { ok: false; code: string; message: string };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS device (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL,
    generation INTEGER NOT NULL,
    wake_id TEXT,
    wake_deadline INTEGER,
    wake_attempts INTEGER NOT NULL,
    sfu_session_id TEXT,
    tracks TEXT NOT NULL,
    rooms TEXT NOT NULL,
    linger_until INTEGER,
    last_error TEXT,
    last_seen INTEGER NOT NULL,
    disconnected_at INTEGER,
    offline_notified INTEGER NOT NULL
  );
  -- Rooms that have viewers interested in this device. A room renews its row while it has viewers.
  CREATE TABLE IF NOT EXISTS watching_rooms (
    room_id TEXT PRIMARY KEY,
    subscribers INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) WITHOUT ROWID;
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
  /** Tables exist from the first connection until the device is forgotten. */
  private ready: boolean;
  /** The SFU session started together with `wake`, so the offer needs one SFU call instead of two. */
  private earlySession: { wakeId: string; sessionId: Promise<string | null> } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = settings(env);
    // Devices send "ping" every 15 s. The runtime answers without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ready = tableExists(ctx.storage.sql, "device");
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

    // A newer connection always wins. The old client stops reconnecting when it gets CLOSE_REPLACED.
    for (const old of this.ctx.getWebSockets()) {
      console.log(JSON.stringify({ event: "device_replaced", deviceId: this.deviceId }));
      closeSocket(old, CLOSE_REPLACED, "Another connection uses the same device_id.");
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connectedAt: now } satisfies SocketAttachment);

    const roomErrors = await this.updateRooms(row, claims, now);
    row = this.row()!;

    // Keep the publication only when this is the same publisher reconnecting its socket.
    const continuing =
      (row.state === "waking" || row.state === "live") &&
      claims.grant.wakeId !== undefined &&
      claims.grant.wakeId === row.wake_id;
    if (!continuing && row.state !== "sleeping") this.resetPublication(row);

    row.last_seen = now;
    row.disconnected_at = null;
    row.offline_notified = 0;
    this.save(row);

    if (this.hasWatchers(now) && row.state === "sleeping") this.startWake(server, now);
    row = this.row()!;

    send(server, {
      action: "joined",
      message: {
        deviceId: this.deviceId,
        state: row.state,
        generation: row.generation,
        rooms: this.rooms(row),
        iceServers: await iceServers(this.env),
      },
    });
    for (const error of roomErrors) sendError(server, error);

    void this.notifyRoomsSoon();
    await this.scheduleAlarm(now);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const incoming = parseIncoming(data);
    if (!incoming) {
      sendError(ws, { code: "message_invalid", message: 'Send JSON like {"action": "...", "message": {...}}.' });
      return;
    }
    switch (incoming.action) {
      case "offer":
        await this.queue.run("publish", () => this.onOffer(ws, incoming.message));
        return;
      case "ready":
        await this.queue.run("publish", () => this.onReady(ws, incoming.message));
        return;
      case "unpublished":
        await this.queue.run("publish", () => this.onUnpublished(ws, incoming.message));
        return;
      default:
        sendError(ws, { code: "action_unknown", message: `Unknown action "${incoming.action}".`, action: incoming.action });
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
    row.disconnected_at = now;
    if (code === 1000 || code === 1001) {
      // The device closed on purpose, e.g. it shut down or changed its ID. It leaves its rooms,
      // so viewers do not keep an offline tile for it. It joins them again when it reconnects.
      const rooms = this.rooms(row);
      this.resetPublication(row);
      row.rooms = "[]";
      row.offline_notified = 1;
      this.save(row);
      this.sql.exec("DELETE FROM watching_rooms");
      await Promise.allSettled(rooms.map((room) => this.env.ROOMS.getByName(room).removeMember(this.deviceId)));
    } else {
      this.save(row);
    }
    await this.scheduleAlarm(now);
  }

  private async onOffer(ws: WebSocket, message: unknown): Promise<void> {
    const parsed = offerMessageSchema.safeParse(message);
    if (!parsed.success) {
      sendError(ws, { code: "offer_invalid", message: "The offer needs wakeId, sdp and tracks.", action: "offer" });
      return;
    }
    const { wakeId, sdp, tracks } = parsed.data;
    const before = this.row();
    if (!before || before.wake_id !== wakeId || before.state === "sleeping") {
      sendError(ws, { code: "wake_stale", message: "This wake is no longer current.", action: "offer" });
      return;
    }

    try {
      const sfu = new RealtimeSfu(this.env);
      const local = tracks.map((track) => ({ location: "local" as const, mid: track.mid, trackName: track.trackName }));
      const early = await this.takeEarlySession(wakeId);
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
      if (!row || row.wake_id !== wakeId || row.state === "sleeping") {
        sendError(ws, { code: "wake_stale", message: "This wake is no longer current.", action: "offer" });
        return;
      }
      // The device is live once it says its PeerConnection is connected ("ready"). Until then
      // the SFU has no packets for these tracks, and viewers would get not_found_track_error.
      const now = Date.now();
      row.state = "waking";
      row.generation += 1;
      row.sfu_session_id = sessionId;
      row.tracks = JSON.stringify(tracks.map((track) => track.trackName));
      row.wake_deadline = now + this.config.wakeTimeoutMs;
      row.last_error = null;
      row.last_seen = now;
      this.save(row);

      send(ws, { action: "answer", message: { wakeId, generation: row.generation, sdp: result.sessionDescription.sdp } });
      if (!this.hasWatchers(now)) this.startLinger(now);
      void this.notifyRoomsSoon();
      await this.scheduleAlarm(now);
    } catch (error) {
      const code = error instanceof SfuError ? error.code : "publish_failed";
      const text = error instanceof Error ? error.message : "Publishing failed.";
      console.log(JSON.stringify({ event: "publish_failed", deviceId: this.deviceId, code }));
      sendError(ws, { code, message: text, action: "offer" });
    }
  }

  private async onReady(ws: WebSocket, message: unknown): Promise<void> {
    const parsed = readyMessageSchema.safeParse(message);
    if (!parsed.success) {
      sendError(ws, { code: "message_invalid", message: "ready needs a wakeId.", action: "ready" });
      return;
    }
    const row = this.row();
    if (!row || row.wake_id !== parsed.data.wakeId || !row.sfu_session_id) {
      sendError(ws, { code: "wake_stale", message: "Send ready after the answer for the current wake.", action: "ready" });
      return;
    }
    if (row.state === "live") return;
    const now = Date.now();
    row.state = "live";
    row.wake_deadline = null;
    row.wake_attempts = 0;
    row.last_error = null;
    this.save(row);
    void this.notifyRoomsSoon();
    await this.scheduleAlarm(now);
  }

  private async onUnpublished(ws: WebSocket, message: unknown): Promise<void> {
    const parsed = unpublishedMessageSchema.safeParse(message);
    if (!parsed.success) {
      sendError(ws, { code: "message_invalid", message: "unpublished needs a wakeId.", action: "unpublished" });
      return;
    }
    const row = this.row();
    if (!row || row.wake_id !== parsed.data.wakeId) return;
    const now = Date.now();
    this.resetPublication(row);
    row.last_error = this.hasWatchers(now) ? "device_stopped" : null;
    this.save(row);
    void this.notifyRoomsSoon();
    await this.scheduleAlarm(now);
  }

  // -------------------------------------------------------------------------
  // RPC from Room
  // -------------------------------------------------------------------------

  /** A room has viewers. Records the interest, wakes the device and returns its state. */
  async watch(roomId: string, subscribers: number): Promise<WatchResult> {
    const now = Date.now();
    const row = this.row();
    if (!row || !this.rooms(row).includes(roomId)) {
      return { member: false, info: this.info(now) };
    }
    this.setWatching(roomId, subscribers, now);
    if (row.linger_until !== null) {
      row.linger_until = null;
      this.save(row);
    }
    const ws = this.socket();
    if (row.state === "sleeping" && ws && this.isOnline(now)) {
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
    this.sql.exec("DELETE FROM watching_rooms WHERE room_id = ?", roomId);
    const row = this.row();
    if (row && row.state !== "sleeping" && !this.hasWatchers(now)) this.startLinger(now);
    await this.scheduleAlarm(now);
  }

  /** Gives a room what it needs to pull this device's tracks, if the viewer limit allows. */
  async resolve(roomId: string, subscribers: number): Promise<ResolveResult> {
    const now = Date.now();
    const row = this.row();
    if (!row || !this.rooms(row).includes(roomId)) {
      return { ok: false, code: "not_member", message: `${this.deviceId} is not in room ${roomId}.` };
    }
    if (row.state !== "live" || !row.sfu_session_id || !this.isOnline(now)) {
      return { ok: false, code: "not_live", message: `${this.deviceId} is not publishing.` };
    }
    const others = this.sql
      .exec<{ total: number | null }>(
        "SELECT SUM(subscribers) AS total FROM watching_rooms WHERE room_id != ? AND expires_at > ?",
        roomId,
        now,
      )
      .one().total ?? 0;
    if (others + subscribers > this.config.maxViewersPerDevice) {
      return {
        ok: false,
        code: "viewer_limit",
        message: `${this.deviceId} already has ${this.config.maxViewersPerDevice} viewers.`,
      };
    }
    this.setWatching(roomId, subscribers, now);
    return { ok: true, sessionId: row.sfu_session_id, generation: row.generation, tracks: JSON.parse(row.tracks) };
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
      info: this.info(now),
      online: this.isOnline(now),
      row: row ? { ...row, tracks: JSON.parse(row.tracks) as string[], rooms: this.rooms(row) } : null,
      watchingRooms: this.ready
        ? this.sql
            .exec<{ room_id: string; subscribers: number; expires_at: number }>("SELECT * FROM watching_rooms ORDER BY room_id")
            .toArray()
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
    this.sql.exec("DELETE FROM used_tokens WHERE expires_at <= ?", now);

    const ws = this.socket();
    if (ws && now - this.lastSeen(ws) > this.config.deviceStaleMs) {
      // Half-open connection: the socket exists but pings stopped.
      console.log(JSON.stringify({ event: "device_stale", deviceId: this.deviceId, silentMs: now - this.lastSeen(ws) }));
      closeSocket(ws, CLOSE_HEARTBEAT_TIMEOUT, "No ping received.");
      row.disconnected_at ??= now;
    }

    const online = this.isOnline(now);
    let changed = false;
    let timedOut = false;

    if (!online && !row.offline_notified && this.disconnectGraceOver(row, now)) {
      row.offline_notified = 1;
      changed = true;
    }

    if (row.state === "waking" && row.wake_deadline !== null && row.wake_deadline <= now) {
      const current = this.socket();
      if (online && current && row.wake_attempts < WAKE_ATTEMPTS && row.wake_id) {
        row.wake_attempts += 1;
        row.wake_deadline = now + this.config.wakeTimeoutMs;
        send(current, { action: "wake", message: { wakeId: row.wake_id } });
      } else {
        this.resetPublication(row);
        row.last_error = "wake_timeout";
        changed = true;
        timedOut = true;
      }
    }

    if (row.linger_until !== null && row.linger_until <= now) {
      row.linger_until = null;
      if (!this.hasWatchers(now)) {
        const current = this.socket();
        if (current && row.wake_id) send(current, { action: "sleep", message: { wakeId: row.wake_id } });
        this.resetPublication(row);
        changed = true;
      }
    }
    this.save(row);

    // Rooms are still watching but the device is not publishing. Try again on the next check,
    // so viewers see the timeout first.
    const current = this.socket();
    if (!timedOut && this.hasWatchers(now) && row.state === "sleeping" && online && current) {
      this.startWake(current, now);
      changed = true;
    }

    if (changed) await this.notifyRoomsSoon();

    row = this.row()!;
    if (!this.socket() && now - row.last_seen > DEVICE_RETENTION_MS) {
      await Promise.allSettled(this.rooms(row).map((room) => this.env.ROOMS.getByName(room).removeMember(this.deviceId)));
      await this.ctx.storage.deleteAll();
      this.ready = false;
      return;
    }
    await this.scheduleAlarm(now);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private row(): DeviceRow | null {
    if (!this.ready) return null;
    return this.sql.exec<DeviceRow>("SELECT * FROM device WHERE id = 1").toArray()[0] ?? null;
  }

  private createRow(now: number): DeviceRow {
    const row: DeviceRow = {
      state: "sleeping",
      generation: 0,
      wake_id: null,
      wake_deadline: null,
      wake_attempts: 0,
      sfu_session_id: null,
      tracks: "[]",
      rooms: "[]",
      linger_until: null,
      last_error: null,
      last_seen: now,
      disconnected_at: null,
      offline_notified: 0,
    };
    this.save(row);
    return row;
  }

  private save(row: DeviceRow): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO device (id, state, generation, wake_id, wake_deadline, wake_attempts,
         sfu_session_id, tracks, rooms, linger_until, last_error, last_seen, disconnected_at, offline_notified)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.state,
      row.generation,
      row.wake_id,
      row.wake_deadline,
      row.wake_attempts,
      row.sfu_session_id,
      row.tracks,
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
  private async updateRooms(row: DeviceRow, claims: Claims, now: number) {
    const wanted = [...new Set(claims.grant.rooms)];
    const previous = this.rooms(row);
    const errors: Array<{ code: string; message: string }> = [];
    const joined: string[] = [];

    const results = await Promise.allSettled(
      wanted.map((room) => this.env.ROOMS.getByName(room).addMember(this.deviceId)),
    );
    results.forEach((result, index) => {
      const room = wanted[index]!;
      if (result.status === "fulfilled" && result.value.ok) {
        joined.push(room);
        if (result.value.viewers > 0) this.setWatching(room, 0, now);
      } else {
        const message =
          result.status === "fulfilled" && !result.value.ok ? result.value.message : `Could not join room ${room}.`;
        errors.push({ code: result.status === "fulfilled" && !result.value.ok ? result.value.code : "room_unavailable", message });
      }
    });

    const left = previous.filter((room) => !joined.includes(room));
    await Promise.allSettled(left.map((room) => this.env.ROOMS.getByName(room).removeMember(this.deviceId)));
    for (const room of left) this.sql.exec("DELETE FROM watching_rooms WHERE room_id = ?", room);

    row.rooms = JSON.stringify(joined);
    this.save(row);
    return errors;
  }

  private setWatching(roomId: string, subscribers: number, now: number): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO watching_rooms (room_id, subscribers, expires_at) VALUES (?, ?, ?)",
      roomId,
      subscribers,
      now + WATCH_LEASE_MS,
    );
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
    row.state = "waking";
    row.wake_id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    row.wake_deadline = now + this.config.wakeTimeoutMs;
    row.wake_attempts = 1;
    row.linger_until = null;
    row.last_error = null;
    this.save(row);
    send(ws, { action: "wake", message: { wakeId: row.wake_id } });
    // The device needs a moment to build its offer. Create the SFU session meanwhile.
    this.earlySession = {
      wakeId: row.wake_id,
      sessionId: new RealtimeSfu(this.env).createSession().catch(() => null),
    };
  }

  /** The session started with this wake, or null when there is none (a retry, or the object restarted). */
  private async takeEarlySession(wakeId: string): Promise<string | null> {
    const early = this.earlySession;
    this.earlySession = null;
    return early?.wakeId === wakeId ? early.sessionId : null;
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
    row.state = "sleeping";
    row.wake_id = null;
    row.wake_deadline = null;
    row.wake_attempts = 0;
    row.sfu_session_id = null;
    row.tracks = "[]";
    row.linger_until = null;
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

  private isOnline(now: number): boolean {
    const ws = this.socket();
    return ws !== null && now - this.lastSeen(ws) <= this.config.deviceStaleMs;
  }

  private disconnectGraceOver(row: DeviceRow, now: number): boolean {
    return row.disconnected_at === null || now - row.disconnected_at >= DISCONNECT_GRACE_MS;
  }

  private info(now: number): DeviceInfo {
    const row = this.row();
    if (!row) return { deviceId: this.deviceId, state: "offline", generation: 0, tracks: [], lastError: null };
    const online = this.isOnline(now) || (row.disconnected_at !== null && !this.disconnectGraceOver(row, now));
    return {
      deviceId: this.deviceId,
      state: online ? row.state : "offline",
      generation: row.generation,
      tracks: online && row.state === "live" ? (JSON.parse(row.tracks) as string[]) : [],
      lastError: row.last_error,
    };
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
        this.sql.exec("DELETE FROM watching_rooms WHERE room_id = ?", rooms[index]!);
      }
    });
  }

  private async scheduleAlarm(now: number): Promise<void> {
    const row = this.row();
    if (!row) return;
    const candidates: number[] = [];
    if (row.wake_deadline !== null) candidates.push(row.wake_deadline);
    if (row.linger_until !== null) candidates.push(row.linger_until);
    if (this.hasWatchers(now)) candidates.push(now + PRESENCE_CHECK_MS);
    const lease = this.sql
      .exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM watching_rooms")
      .one().next;
    if (lease !== null) candidates.push(lease);
    if (!this.socket()) {
      if (row.disconnected_at !== null && !row.offline_notified) {
        candidates.push(row.disconnected_at + DISCONNECT_GRACE_MS);
      }
      candidates.push(row.last_seen + DEVICE_RETENTION_MS);
    }
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), now + 1000));
  }
}
