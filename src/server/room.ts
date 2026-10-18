import { DurableObject } from "cloudflare:workers";

import {
  CloseCode,
  DeviceState,
  ErrorCode,
  ViewerRequest,
  type ControlReady,
  type DataChannel,
  type DataSubscription,
  type DeviceInfo,
  type ReleaseControl,
  type Subscribe,
  type SubscribeAnswer,
  type SubscribeOffer,
  type Subscribed,
  type Subscription,
  type TakeControl,
  type Unsubscribe,
  type ViewerResponse,
} from "../proto/cloudflare";
import { debugInfo, deviceIdMessageSchema, sdpMessageSchema, subscribeSchema, unsubscribeSchema } from "../shared/protocol";
import { PRESENCE_CHECK_MS, WATCH_RENEW_MS, settings, type Settings } from "./config";
import { deviceChannels, iceServers, RealtimeSfu, SfuError, type TrackObject, type TracksResponse } from "./realtime";
import { claimsFromRequest, jsonError, tableExists, useToken } from "./shared";
import {
  KeyedQueue,
  closeSocket,
  decodeFrame,
  requestName,
  sendViewer,
  signalError,
  upgradeRequired,
} from "./socket";

/** A viewer that sends leave gets a normal close. */
const CLOSE_LEFT = 1000;

/** The data channel transport of a viewer's session. */
const DATA_NONE = 0;
const DATA_READY = 1;

type ViewerRow = {
  viewer_id: string;
  sfu_session_id: string | null;
  negotiating: number;
  pending_offer: string | null;
  created_at: number;
  socket_closed_at: number | null;
  /** The token asked for data_channels. */
  data_channels: number;
  data_transport: typeof DATA_NONE | typeof DATA_READY;
};

type DataSubscriptionRow = {
  viewer_id: string;
  device_id: string;
  generation: number;
  /** The device's session the channels were pulled from, needed to change canReply. */
  device_session: string;
  channels: string;
  can_reply: number;
};

type SubscriptionRow = {
  viewer_id: string;
  mid: string;
  device_id: string;
  track_name: string;
  generation: number;
};

type ViewerAttachment = { viewerId: string; connectedAt: number };

export type AddMemberResult = { ok: true; viewers: number } | { ok: false; code: ErrorCode; message: string };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS members (
    device_id TEXT PRIMARY KEY,
    joined_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  -- The last state each device reported, kept only while the room has viewers.
  CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    info TEXT NOT NULL,
    lease_renewed_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS viewers (
    viewer_id TEXT PRIMARY KEY,
    sfu_session_id TEXT,
    negotiating INTEGER NOT NULL,
    pending_offer TEXT,
    created_at INTEGER NOT NULL,
    socket_closed_at INTEGER,
    data_channels INTEGER NOT NULL,
    data_transport INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS subscriptions (
    viewer_id TEXT NOT NULL,
    mid TEXT NOT NULL,
    device_id TEXT NOT NULL,
    track_name TEXT NOT NULL,
    generation INTEGER NOT NULL,
    PRIMARY KEY (viewer_id, mid)
  ) WITHOUT ROWID;
  -- Devices whose _lossy and _reliable a viewer pulled into its session.
  CREATE TABLE IF NOT EXISTS data_subscriptions (
    viewer_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    device_session TEXT NOT NULL,
    channels TEXT NOT NULL,
    can_reply INTEGER NOT NULL,
    PRIMARY KEY (viewer_id, device_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS used_tokens (
    jti TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) WITHOUT ROWID;
`;

/**
 * One instance per room_id. Keeps the member list and the room's viewers: their sockets,
 * their SFU sessions for receiving, and what each one subscribed to. Each viewer has its own
 * queue, so one viewer waiting on the SFU does not hold up the others.
 */
export class Room extends DurableObject<Env> {
  private readonly config: Settings;
  private readonly queue = new KeyedQueue();
  /** Tables exist only while the room has members or viewers. */
  private ready: boolean;
  /** Receive sessions started at join time, by viewer_id. The first subscribe picks one up. */
  private readonly earlySessions = new Map<string, Promise<string | null>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = settings(env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ready = tableExists(ctx.storage.sql, "members");
    // A deploy drops every socket without a close event. Hibernation keeps them, so no sockets
    // here means they are gone: count the viewers as disconnected from now, so they can resume.
    if (this.ready && ctx.getWebSockets().length === 0) {
      ctx.storage.sql.exec("UPDATE viewers SET socket_closed_at = ? WHERE socket_closed_at IS NULL", Date.now());
    }
  }

  private ensureSchema(): void {
    if (this.ready) return;
    this.sql.exec(SCHEMA);
    this.ready = true;
  }

  private get roomId(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("Room must be addressed by name.");
    return name;
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  // -------------------------------------------------------------------------
  // RPC from Device
  // -------------------------------------------------------------------------

  async addMember(deviceId: string): Promise<AddMemberResult> {
    this.ensureSchema();
    const now = Date.now();
    if (!this.isMember(deviceId)) {
      const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members").one().n;
      if (count >= this.config.maxDevicesPerRoom) {
        return {
          ok: false,
          code: ErrorCode.ERROR_CODE_ROOM_FULL,
          message: `Room ${this.roomId} already has ${this.config.maxDevicesPerRoom} devices.`,
        };
      }
      this.sql.exec("INSERT INTO members (device_id, joined_at) VALUES (?, ?)", deviceId, now);
    }
    const viewers = this.viewerCount();
    if (viewers > 0) {
      // The device reports its state right after it joins.
      this.sql.exec(
        "INSERT OR IGNORE INTO devices (device_id, info, lease_renewed_at) VALUES (?, ?, ?)",
        deviceId,
        JSON.stringify(offlineInfo(deviceId)),
        now,
      );
      this.broadcast({ members: { devices: this.memberInfos() } });
    }
    return { ok: true, viewers };
  }

  async removeMember(deviceId: string): Promise<void> {
    if (!this.ready) return;
    this.forgetDevice(deviceId);
    if (this.viewerCount() > 0) this.broadcast({ members: { devices: this.memberInfos() } });
    await this.deleteIfEmpty();
  }

  /** The device hands its control to this viewer. Returns false when the viewer cannot take it. */
  async grantControl(deviceId: string, viewerId: string): Promise<boolean> {
    if (!this.ready) return false;
    return this.queue.run(viewerId, async () => {
      const sub = this.dataSubscription(viewerId, deviceId);
      if (!this.viewer(viewerId) || !sub) return false;
      try {
        await this.setCanReply(viewerId, sub, true);
        return true;
      } catch (error) {
        const code = error instanceof SfuError ? error.code : "internal";
        console.log(JSON.stringify({ event: "grant_control_failed", room: this.roomId, deviceId, viewerId, code }));
        return false;
      }
    });
  }

  /** Takes canReply back, e.g. when the viewer did not confirm control in time. */
  async revokeControl(deviceId: string, viewerId: string, timedOut: boolean): Promise<void> {
    if (!this.ready) return;
    await this.queue.run(viewerId, async () => {
      const sub = this.dataSubscription(viewerId, deviceId);
      if (!sub) return;
      if (sub.can_reply) await this.setCanReply(viewerId, sub, false).catch(() => undefined);
      if (timedOut) {
        this.sendTo(viewerId, {
          error: signalError({
            code: ErrorCode.ERROR_CODE_CONTROL_TIMEOUT,
            message: `You did not confirm control of ${deviceId} in time. Take control again.`,
            request: "control_ready",
            deviceId,
          }),
        });
      }
    });
  }

  /** Returns whether this room still wants updates from the device. */
  async deviceChanged(deviceId: string, info: DeviceInfo): Promise<{ watching: boolean }> {
    if (!this.ready || !this.isMember(deviceId) || this.viewerCount() === 0) return { watching: false };
    this.sql.exec(
      `INSERT INTO devices (device_id, info, lease_renewed_at) VALUES (?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET info = excluded.info`,
      deviceId,
      JSON.stringify(info),
      Date.now(),
    );
    this.broadcast({ device: info });
    return { watching: true };
  }

  // -------------------------------------------------------------------------
  // Viewer socket
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (upgradeRequired(request)) return jsonError(426, "upgrade_required", "Open a WebSocket.");
    const claims = claimsFromRequest(request);
    if (!claims || !claims.grant.canSubscribe || claims.grant.rooms[0] !== this.roomId) {
      return jsonError(400, "claims_invalid", "The token does not match this room.");
    }
    this.ensureSchema();
    const now = Date.now();
    if (!useToken(this.sql, claims, now)) {
      return jsonError(401, "token_used", "The access token was already used. Request a new one.");
    }

    const viewerId = claims.sub;
    const oldSockets = this.ctx.getWebSockets(viewerId);
    let viewer = this.viewer(viewerId);
    let resumed = false;
    if (viewer) {
      const resumable =
        oldSockets.length > 0 ||
        (viewer.socket_closed_at !== null && now - viewer.socket_closed_at <= this.config.viewerResumeMs);
      if (resumable) {
        resumed = true;
      } else {
        await this.dropViewer(viewerId);
        viewer = null;
      }
    }
    for (const old of oldSockets) closeSocket(old, CloseCode.CLOSE_CODE_REPLACED, "Another connection uses the same viewer_id.");

    const wasEmpty = this.viewerCount() === 0;
    if (viewer) {
      this.sql.exec("UPDATE viewers SET socket_closed_at = NULL WHERE viewer_id = ?", viewerId);
    } else {
      this.sql.exec(
        `INSERT INTO viewers (viewer_id, sfu_session_id, negotiating, pending_offer, created_at, socket_closed_at,
           data_channels, data_transport)
         VALUES (?, NULL, 0, NULL, ?, NULL, ?, ?)`,
        viewerId,
        now,
        claims.grant.dataChannels ? 1 : 0,
        DATA_NONE,
      );
    }
    // Devices are waking now. Create the receive session meanwhile, so the first subscribe
    // needs one SFU call less.
    if (!viewer?.sfu_session_id && !this.earlySessions.has(viewerId)) {
      this.earlySessions.set(viewerId, new RealtimeSfu(this.env).createSession().catch(() => null));
    }
    if (wasEmpty) await this.watchAll(now);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [viewerId]);
    server.serializeAttachment({ viewerId, connectedAt: now } satisfies ViewerAttachment);

    sendViewer(server, {
      joined: {
        viewerId,
        room: this.roomId,
        resumed,
        iceServers: await iceServers(this.env),
        devices: this.memberInfos(),
        subscriptions: resumed ? this.subscriptions(viewerId) : [],
        data: resumed ? this.dataSubscriptions(viewerId) : [],
      },
    });
    // A viewer that dropped while an offer was pending gets the same offer again.
    if (resumed && viewer?.negotiating && viewer.pending_offer) {
      sendViewer(server, {
        offer: { sdp: viewer.pending_offer, tracks: this.subscriptions(viewerId), sessionReset: false },
      });
    }
    await this.scheduleAlarm(now);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as ViewerAttachment | null;
    // A replaced socket is closing: what it still sends, e.g. a late leave, belongs to the old connection.
    if (!attachment || !this.ready || ws.readyState !== WebSocket.OPEN) return;
    const request = decodeFrame(ViewerRequest, data);
    const name = request ? requestName(request) : "";
    if (!request || !name) {
      this.fail(ws, ErrorCode.ERROR_CODE_INVALID_MESSAGE, "Send a binary ViewerRequest.", name);
      return;
    }
    const { viewerId } = attachment;
    const run = (task: () => Promise<void>) =>
      this.queue.run(viewerId, async () => {
        if (!this.viewer(viewerId)) {
          this.fail(ws, ErrorCode.ERROR_CODE_VIEWER_GONE, "Join the room again.", name);
          return;
        }
        try {
          await task();
        } catch (error) {
          const sfu = error instanceof SfuError;
          const message = error instanceof Error ? error.message : "Something went wrong.";
          console.log(JSON.stringify({ event: "viewer_request_failed", room: this.roomId, request: name, code: sfu ? error.code : "internal" }));
          this.fail(ws, sfu ? ErrorCode.ERROR_CODE_SFU : ErrorCode.ERROR_CODE_INTERNAL, message, name);
        }
      });
    const { subscribe, answer, unsubscribe, leave, takeControl, releaseControl, controlReady, offer } = request;
    if (subscribe) {
      const asked = [...subscribe.tracks.map((track) => track.deviceId), ...subscribe.data];
      await run(() => this.onSubscribe(ws, viewerId, subscribe).finally(() => this.releaseViewer(viewerId, asked)));
    } else if (answer) {
      await run(() => this.onAnswer(ws, viewerId, answer));
    } else if (unsubscribe) {
      await run(() => this.onUnsubscribe(ws, viewerId, unsubscribe));
    } else if (leave) {
      await run(async () => {
        await this.dropViewer(viewerId);
        closeSocket(ws, CLOSE_LEFT, "Left the room.");
      });
    } else if (takeControl) {
      await run(() => this.onTakeControl(ws, viewerId, takeControl));
    } else if (releaseControl) {
      await run(() => this.onReleaseControl(ws, viewerId, releaseControl));
    } else if (controlReady) {
      await run(() => this.onControlReady(ws, viewerId, controlReady));
    } else if (offer) {
      await run(() => this.onViewerOffer(ws, viewerId, offer));
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const attachment = ws.deserializeAttachment() as ViewerAttachment | null;
    console.log(JSON.stringify({ event: "viewer_socket_closed", room: this.ready ? this.roomId : null, viewerId: attachment?.viewerId ?? null, code }));
    await this.onSocketGone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  private async onSocketGone(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as ViewerAttachment | null;
    if (!attachment || !this.ready) return;
    if (this.ctx.getWebSockets(attachment.viewerId).some((other) => other !== ws)) return;
    if (!this.viewer(attachment.viewerId)) return;
    const now = Date.now();
    this.sql.exec(
      "UPDATE viewers SET socket_closed_at = COALESCE(socket_closed_at, ?) WHERE viewer_id = ?",
      now,
      attachment.viewerId,
    );
    await this.scheduleAlarm(now);
  }

  private async onSubscribe(ws: WebSocket, viewerId: string, message: Subscribe): Promise<void> {
    const parsed = subscribeSchema.safeParse(message);
    if (!parsed.success) {
      this.fail(ws, ErrorCode.ERROR_CODE_INVALID_MESSAGE, "subscribe needs tracks [{deviceId, trackName}] or data [deviceId].", "subscribe");
      return;
    }
    const viewer = this.viewer(viewerId)!;
    if (viewer.negotiating) {
      this.fail(ws, ErrorCode.ERROR_CODE_BUSY, "Send the answer for the last offer first.", "subscribe");
      return;
    }
    // Data channels need no SDP, so they go first and the media offer comes last.
    if (parsed.data.data.length > 0) await this.subscribeData(ws, viewer, parsed.data.data);
    if (parsed.data.tracks.length === 0) {
      sendViewer(ws, { subscribed: this.subscribed(viewerId) });
      return;
    }

    const current = this.subscriptions(viewerId);
    const byDevice = new Map<string, Set<string>>();
    for (const track of parsed.data.tracks) {
      if (!this.isMember(track.deviceId)) {
        this.failTrack(ws, {
          code: ErrorCode.ERROR_CODE_NOT_MEMBER,
          message: `${track.deviceId} is not in this room.`,
          deviceId: track.deviceId,
        });
        continue;
      }
      if (!byDevice.has(track.deviceId)) byDevice.set(track.deviceId, new Set());
      byDevice.get(track.deviceId)!.add(track.trackName);
    }

    const remote: TrackObject[] = [];
    const wanted: Array<{ deviceId: string; trackName: string; generation: number }> = [];
    for (const [deviceId, names] of byDevice) {
      const resolved = await this.env.DEVICES.getByName(deviceId).resolve(this.roomId, viewerId);
      if (!resolved.ok) {
        this.failTrack(ws, {
          code: resolved.code,
          message: resolved.message,
          deviceId,
          retryable: resolved.code === ErrorCode.ERROR_CODE_NOT_LIVE,
        });
        continue;
      }
      for (const trackName of names) {
        if (!resolved.tracks.includes(trackName)) {
          this.failTrack(ws, {
            code: ErrorCode.ERROR_CODE_TRACK_NOT_FOUND,
            message: `${deviceId} has no track ${trackName}.`,
            deviceId,
            trackName,
          });
          continue;
        }
        const duplicate = current.some(
          (sub) => sub.deviceId === deviceId && sub.trackName === trackName && sub.generation === resolved.generation,
        );
        if (duplicate) continue;
        remote.push({ location: "remote", sessionId: resolved.sessionId, trackName });
        wanted.push({ deviceId, trackName, generation: resolved.generation });
      }
    }
    if (remote.length === 0) {
      sendViewer(ws, { subscribed: this.subscribed(viewerId) });
      return;
    }

    const sfu = new RealtimeSfu(this.env);
    let sessionId = viewer.sfu_session_id;
    let sessionReset = false;
    if (!sessionId) {
      const early = this.earlySessions.get(viewerId);
      this.earlySessions.delete(viewerId);
      sessionId = (early && (await early)) || (await sfu.createSession());
      this.sql.exec("UPDATE viewers SET sfu_session_id = ? WHERE viewer_id = ?", sessionId, viewerId);
    }
    let result: TracksResponse;
    try {
      result = await sfu.addTracks(sessionId, remote);
    } catch (error) {
      if (!(error instanceof SfuError && error.sessionGone)) throw error;
      // The session expired, e.g. it was made at join time and nothing was live for a long
      // time. The viewer has to start a new PeerConnection for the new one.
      this.sql.exec("DELETE FROM subscriptions WHERE viewer_id = ?", viewerId);
      // The new PeerConnection has no data channel transport either. The viewer sends its offer again.
      await this.dropData(viewerId);
      this.sql.exec("UPDATE viewers SET data_transport = ? WHERE viewer_id = ?", DATA_NONE, viewerId);
      sessionId = await this.newSession(sfu, viewerId);
      sessionReset = true;
      result = await sfu.addTracks(sessionId, remote);
    }

    const returned = result.tracks ?? [];
    wanted.forEach((track, index) => {
      const item = returned[index];
      if (item?.errorCode || !item?.mid) {
        // Usually not_found_track_error: the device is connected but its media is not there yet.
        this.failTrack(ws, {
          code: ErrorCode.ERROR_CODE_TRACK_NOT_READY,
          message: `${item?.errorCode ?? "track_failed"}: ${item?.errorDescription ?? `Could not pull ${track.trackName}.`}`,
          deviceId: track.deviceId,
          trackName: track.trackName,
          retryable: true,
        });
        return;
      }
      const mid = item.mid;
      this.sql.exec(
        "INSERT OR REPLACE INTO subscriptions (viewer_id, mid, device_id, track_name, generation) VALUES (?, ?, ?, ?, ?)",
        viewerId,
        mid,
        track.deviceId,
        track.trackName,
        track.generation,
      );
    });
    this.finishNegotiation(ws, viewerId, result, sessionReset);
  }

  private async onAnswer(ws: WebSocket, viewerId: string, message: SubscribeAnswer): Promise<void> {
    const parsed = sdpMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.fail(ws, ErrorCode.ERROR_CODE_INVALID_MESSAGE, "answer needs an sdp.", "answer");
      return;
    }
    const viewer = this.viewer(viewerId)!;
    if (!viewer.negotiating || !viewer.sfu_session_id) {
      this.fail(ws, ErrorCode.ERROR_CODE_NO_OFFER, "There is no offer waiting for an answer.", "answer");
      return;
    }
    await new RealtimeSfu(this.env).renegotiate(viewer.sfu_session_id, parsed.data.sdp);
    this.sql.exec("UPDATE viewers SET negotiating = 0, pending_offer = NULL WHERE viewer_id = ?", viewerId);
    sendViewer(ws, { subscribed: this.subscribed(viewerId) });
  }

  /**
   * The viewer's own offer, with only an m=application section. The SFU answers it at once: one SFU
   * call, no renegotiate. The viewer connects only once the SFU has the whole exchange, which avoids
   * most DTLS waits, and it connects while the devices wake. Data channels need this transport.
   */
  private async onViewerOffer(ws: WebSocket, viewerId: string, message: SubscribeOffer): Promise<void> {
    const parsed = sdpMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.fail(ws, ErrorCode.ERROR_CODE_INVALID_MESSAGE, "offer needs an sdp.", "offer");
      return;
    }
    const viewer = this.viewer(viewerId)!;
    if (viewer.negotiating) {
      this.fail(ws, ErrorCode.ERROR_CODE_BUSY, "Send the answer for the last offer first.", "offer");
      return;
    }
    const sfu = new RealtimeSfu(this.env);
    let sessionId = viewer.sfu_session_id;
    if (!sessionId) {
      const early = this.earlySessions.get(viewerId);
      this.earlySessions.delete(viewerId);
      sessionId = (early && (await early)) || (await sfu.createSession());
      this.sql.exec("UPDATE viewers SET sfu_session_id = ? WHERE viewer_id = ?", sessionId, viewerId);
    }
    let answer;
    try {
      answer = await sfu.establishDataChannels(sessionId, parsed.data.sdp);
    } catch (error) {
      // A session made at join time can expire before the offer. One with tracks cannot be replaced here.
      if (!(error instanceof SfuError && error.sessionGone) || this.subscriptions(viewerId).length > 0) throw error;
      sessionId = await this.newSession(sfu, viewerId);
      answer = await sfu.establishDataChannels(sessionId, parsed.data.sdp);
    }
    this.sql.exec("UPDATE viewers SET data_transport = ? WHERE viewer_id = ?", DATA_READY, viewerId);
    sendViewer(ws, { answer: { sdp: answer.sdp } });
  }

  /** Pulls each device's _lossy and _reliable into the viewer's session. No SDP needed. */
  private async subscribeData(ws: WebSocket, viewer: ViewerRow, deviceIds: string[]): Promise<void> {
    const viewerId = viewer.viewer_id;
    if (!viewer.data_channels) {
      this.fail(ws, ErrorCode.ERROR_CODE_DATA_CHANNELS_OFF, "Ask for data_channels in the token to open data channels.", "subscribe");
      return;
    }
    const sessionId = viewer.sfu_session_id;
    if (viewer.data_transport !== DATA_READY || !sessionId) {
      this.fail(ws, ErrorCode.ERROR_CODE_BUSY, "Send your own offer first.", "subscribe");
      return;
    }
    const sfu = new RealtimeSfu(this.env);
    for (const deviceId of new Set(deviceIds)) {
      if (!this.isMember(deviceId)) {
        this.failTrack(ws, { code: ErrorCode.ERROR_CODE_NOT_MEMBER, message: `${deviceId} is not in this room.`, deviceId });
        continue;
      }
      const resolved = await this.env.DEVICES.getByName(deviceId).resolve(this.roomId, viewerId);
      if (!resolved.ok) {
        this.failTrack(ws, {
          code: resolved.code,
          message: resolved.message,
          deviceId,
          retryable: resolved.code === ErrorCode.ERROR_CODE_NOT_LIVE,
        });
        continue;
      }
      if (!resolved.dataChannels) {
        this.failTrack(ws, { code: ErrorCode.ERROR_CODE_NO_DATA_CHANNELS, message: `${deviceId} has no data channels.`, deviceId });
        continue;
      }
      const current = this.dataSubscription(viewerId, deviceId);
      if (current?.generation === resolved.generation) continue;
      // The device published again: its old channels went with its old session.
      if (current) await this.closeData(sfu, sessionId, current);
      try {
        const channels = await sfu.addDataChannels(sessionId, deviceChannels("remote", resolved.sessionId, resolved.canReply));
        this.sql.exec(
          `INSERT OR REPLACE INTO data_subscriptions (viewer_id, device_id, generation, device_session, channels, can_reply)
           VALUES (?, ?, ?, ?, ?, ?)`,
          viewerId,
          deviceId,
          resolved.generation,
          resolved.sessionId,
          JSON.stringify(channels),
          resolved.canReply ? 1 : 0,
        );
      } catch (error) {
        this.sql.exec("DELETE FROM data_subscriptions WHERE viewer_id = ? AND device_id = ?", viewerId, deviceId);
        this.failTrack(ws, {
          code: ErrorCode.ERROR_CODE_SFU,
          message: error instanceof Error ? error.message : `Could not open ${deviceId}'s data channels.`,
          deviceId,
          retryable: true,
        });
      }
    }
  }

  /** Closes the viewer's channels to these devices. A controller gives up its control. */
  private async unsubscribeData(viewer: ViewerRow, deviceIds: string[]): Promise<void> {
    const sfu = new RealtimeSfu(this.env);
    for (const deviceId of new Set(deviceIds)) {
      const sub = this.dataSubscription(viewer.viewer_id, deviceId);
      if (!sub) continue;
      if (viewer.sfu_session_id) await this.closeData(sfu, viewer.sfu_session_id, sub);
      this.sql.exec("DELETE FROM data_subscriptions WHERE viewer_id = ? AND device_id = ?", viewer.viewer_id, deviceId);
      await this.env.DEVICES.getByName(deviceId).controlGone(this.roomId, viewer.viewer_id).catch(() => undefined);
    }
    await this.releaseViewer(viewer.viewer_id, deviceIds);
  }

  private async closeData(sfu: RealtimeSfu, sessionId: string, sub: DataSubscriptionRow): Promise<void> {
    const ids = (JSON.parse(sub.channels) as DataChannel[]).map((channel) => channel.id);
    await sfu.closeDataChannels(sessionId, ids).catch(() => undefined);
  }

  private async onTakeControl(ws: WebSocket, viewerId: string, message: TakeControl): Promise<void> {
    const parsed = deviceIdMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.fail(ws, ErrorCode.ERROR_CODE_INVALID_MESSAGE, "take_control needs a deviceId.", "take_control");
      return;
    }
    const { deviceId } = parsed.data;
    if (!this.viewer(viewerId)!.data_channels) {
      this.failControl(ws, ErrorCode.ERROR_CODE_DATA_CHANNELS_OFF, "Ask for data_channels in the token to take control.", deviceId, "take_control");
      return;
    }
    if (!this.dataSubscription(viewerId, deviceId)) {
      this.failControl(ws, ErrorCode.ERROR_CODE_NO_DATA_CHANNELS, `Open ${deviceId}'s data channels first.`, deviceId, "take_control");
      return;
    }
    const result = await this.env.DEVICES.getByName(deviceId).takeControl(this.roomId, viewerId);
    if (!result.ok) this.failControl(ws, result.code, result.message, deviceId, "take_control");
  }

  private async onReleaseControl(ws: WebSocket, viewerId: string, message: ReleaseControl): Promise<void> {
    const parsed = deviceIdMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.fail(ws, ErrorCode.ERROR_CODE_INVALID_MESSAGE, "release_control needs a deviceId.", "release_control");
      return;
    }
    const { deviceId } = parsed.data;
    const sub = this.dataSubscription(viewerId, deviceId);
    // Stop this viewer's messages before the next one takes over. If the SFU fails, give up the
    // control anyway, so the viewers waiting are not stuck behind it.
    if (sub?.can_reply) {
      await this.setCanReply(viewerId, sub, false).catch((error) => {
        console.log(JSON.stringify({ event: "revoke_failed", room: this.roomId, deviceId, code: error instanceof SfuError ? error.code : "internal" }));
      });
    }
    const result = await this.env.DEVICES.getByName(deviceId).releaseControl(this.roomId, viewerId);
    if (!result.ok) this.failControl(ws, result.code, result.message, deviceId, "release_control");
  }

  private async onControlReady(ws: WebSocket, viewerId: string, message: ControlReady): Promise<void> {
    const parsed = deviceIdMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.fail(ws, ErrorCode.ERROR_CODE_INVALID_MESSAGE, "control_ready needs a deviceId.", "control_ready");
      return;
    }
    const { deviceId } = parsed.data;
    if (!this.dataSubscription(viewerId, deviceId)?.can_reply) {
      this.failControl(ws, ErrorCode.ERROR_CODE_NOT_CONTROLLER, `${deviceId} was not handed to you.`, deviceId, "control_ready");
      return;
    }
    const result = await this.env.DEVICES.getByName(deviceId).confirmControl(this.roomId, viewerId);
    if (!result.ok) this.failControl(ws, result.code, result.message, deviceId, "control_ready");
  }

  /** Grants or revokes canReply on the viewer's two channels to the device, and tells the viewer. */
  private async setCanReply(viewerId: string, sub: DataSubscriptionRow, canReply: boolean): Promise<void> {
    const sessionId = this.viewer(viewerId)?.sfu_session_id;
    if (!sessionId) throw new Error("The viewer has no session.");
    await new RealtimeSfu(this.env).updateDataChannels(sessionId, deviceChannels("remote", sub.device_session, canReply));
    this.sql.exec(
      "UPDATE data_subscriptions SET can_reply = ? WHERE viewer_id = ? AND device_id = ?",
      canReply ? 1 : 0,
      viewerId,
      sub.device_id,
    );
    this.sendTo(viewerId, { subscribed: this.subscribed(viewerId) });
  }

  private async onUnsubscribe(ws: WebSocket, viewerId: string, message: Unsubscribe): Promise<void> {
    const parsed = unsubscribeSchema.safeParse(message);
    if (!parsed.success) {
      this.fail(ws, ErrorCode.ERROR_CODE_INVALID_MESSAGE, "unsubscribe needs mids or data.", "unsubscribe");
      return;
    }
    const viewer = this.viewer(viewerId)!;
    if (viewer.negotiating) {
      this.fail(ws, ErrorCode.ERROR_CODE_BUSY, "Send the answer for the last offer first.", "unsubscribe");
      return;
    }
    if (parsed.data.data.length > 0) await this.unsubscribeData(viewer, parsed.data.data);
    const closing = this.subscriptions(viewerId).filter((sub) => parsed.data.mids.includes(sub.mid));
    if (closing.length === 0 || !viewer.sfu_session_id) {
      sendViewer(ws, { subscribed: this.subscribed(viewerId) });
      return;
    }

    let result: TracksResponse = {};
    try {
      result = await new RealtimeSfu(this.env).closeTracks(
        viewer.sfu_session_id,
        closing.map((sub) => sub.mid),
      );
    } catch (error) {
      if (!(error instanceof SfuError && error.sessionGone)) throw error;
    }
    for (const sub of closing) {
      this.sql.exec("DELETE FROM subscriptions WHERE viewer_id = ? AND mid = ?", viewerId, sub.mid);
    }
    await this.releaseViewer(viewerId, closing.map((sub) => sub.deviceId));
    this.finishNegotiation(ws, viewerId, result, false);
  }

  /** Sends the SFU's offer when it needs an answer, otherwise confirms the subscriptions. */
  private finishNegotiation(ws: WebSocket, viewerId: string, result: TracksResponse, sessionReset: boolean): void {
    const tracks = this.subscriptions(viewerId);
    if (result.requiresImmediateRenegotiation && result.sessionDescription?.type === "offer") {
      this.sql.exec(
        "UPDATE viewers SET negotiating = 1, pending_offer = ? WHERE viewer_id = ?",
        result.sessionDescription.sdp,
        viewerId,
      );
      sendViewer(ws, { offer: { sdp: result.sessionDescription.sdp, tracks, sessionReset } });
      return;
    }
    sendViewer(ws, { subscribed: this.subscribed(viewerId) });
  }

  private async newSession(sfu: RealtimeSfu, viewerId: string): Promise<string> {
    const sessionId = await sfu.createSession();
    this.sql.exec("UPDATE viewers SET sfu_session_id = ? WHERE viewer_id = ?", sessionId, viewerId);
    return sessionId;
  }

  // -------------------------------------------------------------------------
  // Alarm
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    if (!this.ready) return;
    const now = Date.now();
    this.sql.exec("DELETE FROM used_tokens WHERE expires_at <= ?", now);

    // Half-open sockets: the socket exists but pings stopped.
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN || now - this.lastSeen(ws) <= this.config.viewerStaleMs) continue;
      const attachment = ws.deserializeAttachment() as ViewerAttachment | null;
      console.log(JSON.stringify({ event: "viewer_stale", room: this.roomId, viewerId: attachment?.viewerId ?? null }));
      closeSocket(ws, CloseCode.CLOSE_CODE_HEARTBEAT_TIMEOUT, "No ping received.");
      if (attachment) {
        this.sql.exec(
          "UPDATE viewers SET socket_closed_at = COALESCE(socket_closed_at, ?) WHERE viewer_id = ?",
          now,
          attachment.viewerId,
        );
      }
    }

    // Viewers that did not come back in time.
    const expired = this.sql
      .exec<{ viewer_id: string }>(
        "SELECT viewer_id FROM viewers WHERE socket_closed_at IS NOT NULL AND socket_closed_at <= ?",
        now - this.config.viewerResumeMs,
      )
      .toArray();
    for (const { viewer_id } of expired) {
      const open = this.ctx.getWebSockets(viewer_id).some((ws) => ws.readyState === WebSocket.OPEN);
      if (!open) await this.dropViewer(viewer_id);
    }

    // Keep telling the devices that this room is still watching.
    if (this.viewerCount() > 0) {
      const stale = this.sql
        .exec<{ device_id: string }>(
          `SELECT m.device_id FROM members m LEFT JOIN devices d ON d.device_id = m.device_id
           WHERE d.device_id IS NULL OR d.lease_renewed_at <= ?`,
          now - WATCH_RENEW_MS,
        )
        .toArray()
        .map((row) => row.device_id);
      await Promise.allSettled(stale.map((deviceId) => this.watchDevice(deviceId, now)));
    }

    if (await this.deleteIfEmpty()) return;
    await this.scheduleAlarm(now);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Everything this object holds, for the local debug page. Includes SFU session IDs. */
  async debugState() {
    const now = Date.now();
    if (!this.ready) {
      return { roomId: this.roomId, now, members: [], devices: [], viewers: [], alarm: null };
    }
    const viewers = this.sql.exec<ViewerRow>("SELECT * FROM viewers ORDER BY created_at").toArray();
    return {
      roomId: this.roomId,
      now,
      members: this.sql.exec<{ device_id: string; joined_at: number }>("SELECT * FROM members ORDER BY device_id").toArray(),
      devices: this.sql
        .exec<{ device_id: string; info: string; lease_renewed_at: number }>("SELECT * FROM devices ORDER BY device_id")
        .toArray()
        .map((row) => ({
          deviceId: row.device_id,
          info: debugInfo(JSON.parse(row.info) as DeviceInfo),
          leaseRenewedAt: row.lease_renewed_at,
        })),
      viewers: viewers.map((viewer) => ({
        viewerId: viewer.viewer_id,
        state: viewerState(viewer),
        sfuSessionId: viewer.sfu_session_id,
        negotiating: Boolean(viewer.negotiating),
        pendingOfferBytes: viewer.pending_offer?.length ?? 0,
        createdAt: viewer.created_at,
        socketClosedAt: viewer.socket_closed_at,
        sockets: this.ctx.getWebSockets(viewer.viewer_id).map((ws) => ({
          readyState: ws.readyState,
          connectedAt: (ws.deserializeAttachment() as ViewerAttachment | null)?.connectedAt ?? null,
          lastPing: this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null,
        })),
        subscriptions: this.subscriptions(viewer.viewer_id),
        dataChannels: Boolean(viewer.data_channels),
        dataTransport: viewer.data_transport === DATA_READY ? "ready" : "none",
        data: this.dataSubscriptions(viewer.viewer_id),
      })),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  private viewer(viewerId: string): ViewerRow | null {
    return this.sql.exec<ViewerRow>("SELECT * FROM viewers WHERE viewer_id = ?", viewerId).toArray()[0] ?? null;
  }

  private viewerCount(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM viewers").one().n;
  }

  private isMember(deviceId: string): boolean {
    return this.sql.exec("SELECT 1 FROM members WHERE device_id = ?", deviceId).toArray().length > 0;
  }

  private memberInfos(): DeviceInfo[] {
    return this.sql
      .exec<{ device_id: string; info: string | null }>(
        `SELECT m.device_id, d.info FROM members m LEFT JOIN devices d ON d.device_id = m.device_id
         ORDER BY m.device_id`,
      )
      .toArray()
      .map((row) => (row.info ? (JSON.parse(row.info) as DeviceInfo) : offlineInfo(row.device_id)));
  }

  private subscriptions(viewerId: string): Subscription[] {
    return this.sql
      .exec<SubscriptionRow>("SELECT * FROM subscriptions WHERE viewer_id = ? ORDER BY mid", viewerId)
      .toArray()
      .map((row) => ({ deviceId: row.device_id, trackName: row.track_name, mid: row.mid, generation: row.generation }));
  }

  private dataSubscription(viewerId: string, deviceId: string): DataSubscriptionRow | null {
    return (
      this.sql
        .exec<DataSubscriptionRow>("SELECT * FROM data_subscriptions WHERE viewer_id = ? AND device_id = ?", viewerId, deviceId)
        .toArray()[0] ?? null
    );
  }

  private dataSubscriptions(viewerId: string): DataSubscription[] {
    return this.sql
      .exec<DataSubscriptionRow>("SELECT * FROM data_subscriptions WHERE viewer_id = ? ORDER BY device_id", viewerId)
      .toArray()
      .map((row) => ({
        deviceId: row.device_id,
        generation: row.generation,
        channels: JSON.parse(row.channels) as DataChannel[],
        canReply: Boolean(row.can_reply),
      }));
  }

  private subscribed(viewerId: string): Subscribed {
    return { tracks: this.subscriptions(viewerId), data: this.dataSubscriptions(viewerId) };
  }

  /** Viewers in this room that receive a track or the data channels of the device. */
  private subscribedViewers(deviceId: string): string[] {
    return this.sql
      .exec<{ viewer_id: string }>(
        `SELECT viewer_id FROM subscriptions WHERE device_id = ?
         UNION SELECT viewer_id FROM data_subscriptions WHERE device_id = ?`,
        deviceId,
        deviceId,
      )
      .toArray()
      .map((row) => row.viewer_id);
  }

  /**
   * The device counts a viewer from its first successful resolve. Once the viewer gets nothing from
   * the device (it unsubscribed, left, or its subscribe failed), the device stops counting it.
   */
  private async releaseViewer(viewerId: string, deviceIds: Iterable<string>): Promise<void> {
    const done = [...new Set(deviceIds)].filter((deviceId) => !this.isSubscribedTo(viewerId, deviceId));
    await Promise.allSettled(done.map((deviceId) => this.env.DEVICES.getByName(deviceId).release(this.roomId, viewerId)));
  }

  private isSubscribedTo(viewerId: string, deviceId: string): boolean {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM subscriptions WHERE viewer_id = ? AND device_id = ?
           UNION SELECT 1 FROM data_subscriptions WHERE viewer_id = ? AND device_id = ?`,
          viewerId,
          deviceId,
          viewerId,
          deviceId,
        )
        .toArray().length > 0
    );
  }

  /** Forgets a device that left the room. Its own object drops this room's control state. */
  private forgetDevice(deviceId: string): void {
    this.sql.exec("DELETE FROM members WHERE device_id = ?", deviceId);
    this.sql.exec("DELETE FROM devices WHERE device_id = ?", deviceId);
    this.sql.exec("DELETE FROM data_subscriptions WHERE device_id = ?", deviceId);
  }

  /** Forgets the viewer's data channels; each device drops it from its control state. */
  private async dropData(viewerId: string): Promise<string[]> {
    const deviceIds = this.dataSubscriptions(viewerId).map((sub) => sub.deviceId);
    this.sql.exec("DELETE FROM data_subscriptions WHERE viewer_id = ?", viewerId);
    await Promise.allSettled(deviceIds.map((deviceId) => this.env.DEVICES.getByName(deviceId).controlGone(this.roomId, viewerId)));
    return deviceIds;
  }

  private async watchAll(now: number): Promise<void> {
    const members = this.sql
      .exec<{ device_id: string }>("SELECT device_id FROM members")
      .toArray()
      .map((row) => row.device_id);
    await Promise.allSettled(members.map((deviceId) => this.watchDevice(deviceId, now)));
  }

  private async watchDevice(deviceId: string, now: number): Promise<void> {
    const result = await this.env.DEVICES.getByName(deviceId).watch(this.roomId, this.subscribedViewers(deviceId));
    if (!result.member) {
      this.forgetDevice(deviceId);
      if (this.viewerCount() > 0) this.broadcast({ members: { devices: this.memberInfos() } });
      return;
    }
    const previous = this.sql
      .exec<{ info: string }>("SELECT info FROM devices WHERE device_id = ?", deviceId)
      .toArray()[0]?.info;
    const info = JSON.stringify(result.info);
    // Every viewer must see the same state, including changes found while renewing.
    if (previous !== undefined && previous !== info) this.broadcast({ device: result.info });
    this.sql.exec(
      `INSERT INTO devices (device_id, info, lease_renewed_at) VALUES (?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET info = excluded.info, lease_renewed_at = excluded.lease_renewed_at`,
      deviceId,
      info,
      now,
    );
  }

  private async dropViewer(viewerId: string): Promise<void> {
    this.earlySessions.delete(viewerId);
    const affected = new Set(this.subscriptions(viewerId).map((sub) => sub.deviceId));
    for (const deviceId of await this.dropData(viewerId)) affected.add(deviceId);
    this.sql.exec("DELETE FROM subscriptions WHERE viewer_id = ?", viewerId);
    this.sql.exec("DELETE FROM viewers WHERE viewer_id = ?", viewerId);
    if (this.viewerCount() > 0) {
      await this.releaseViewer(viewerId, affected);
      return;
    }
    // Nobody is watching any more. Each device sleeps after its linger time.
    const members = this.sql
      .exec<{ device_id: string }>("SELECT device_id FROM members")
      .toArray()
      .map((row) => row.device_id);
    await Promise.allSettled(members.map((deviceId) => this.env.DEVICES.getByName(deviceId).unwatch(this.roomId)));
    this.sql.exec("DELETE FROM devices");
  }

  /** Sends to the viewer's open sockets; there is one unless a replaced one is still closing. */
  private sendTo(viewerId: string, message: ViewerResponse): void {
    for (const ws of this.ctx.getWebSockets(viewerId)) {
      if (ws.readyState === WebSocket.OPEN) sendViewer(ws, message);
    }
  }

  private broadcast(message: ViewerResponse): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN) sendViewer(ws, message);
    }
  }

  private fail(ws: WebSocket, code: ErrorCode, message: string, request: string): void {
    sendViewer(ws, { error: signalError({ code, message, request }) });
  }

  private failControl(ws: WebSocket, code: ErrorCode, message: string, deviceId: string, request: string): void {
    sendViewer(ws, { error: signalError({ code, message, request, deviceId }) });
  }

  /** An error for one device or track of a subscribe. The rest of the request goes on. */
  private failTrack(
    ws: WebSocket,
    fields: { code: ErrorCode; message: string; deviceId: string; trackName?: string; retryable?: boolean },
  ): void {
    sendViewer(ws, { error: signalError({ ...fields, request: "subscribe" }) });
  }

  private lastSeen(ws: WebSocket): number {
    const pong = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    const attachment = ws.deserializeAttachment() as ViewerAttachment | null;
    return Math.max(pong, attachment?.connectedAt ?? 0);
  }

  private async scheduleAlarm(now: number): Promise<void> {
    if (this.viewerCount() === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const closed = this.sql
      .exec<{ next: number | null }>("SELECT MIN(socket_closed_at) AS next FROM viewers")
      .one().next;
    const candidates = [now + PRESENCE_CHECK_MS];
    if (closed !== null) candidates.push(closed + this.config.viewerResumeMs);
    // Check again when a viewer's last ping turns stale.
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN) candidates.push(this.lastSeen(ws) + this.config.viewerStaleMs + 1000);
    }
    await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), now + 1000));
  }

  /** An empty room keeps nothing: no tables, no alarm. */
  private async deleteIfEmpty(): Promise<boolean> {
    const members = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members").one().n;
    if (members > 0 || this.viewerCount() > 0) return false;
    await this.ctx.storage.deleteAll();
    this.ready = false;
    return true;
  }
}

/**
 * For the debug view. away: the socket closed and the viewer may still resume. joined: no SFU
 * session yet. ready: it has one.
 */
function viewerState(viewer: ViewerRow): "away" | "negotiating" | "joined" | "ready" {
  if (viewer.socket_closed_at !== null) return "away";
  if (viewer.negotiating) return "negotiating";
  return viewer.sfu_session_id ? "ready" : "joined";
}

function offlineInfo(deviceId: string): DeviceInfo {
  return {
    deviceId,
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
