import { DurableObject } from "cloudflare:workers";

import {
  CLOSE_HEARTBEAT_TIMEOUT,
  CLOSE_LEFT,
  CLOSE_REPLACED,
  answerMessageSchema,
  subscribeMessageSchema,
  unsubscribeMessageSchema,
  type DeviceInfo,
  type OutgoingMessage,
  type Subscription,
} from "../shared/protocol";
import { PRESENCE_CHECK_MS, WATCH_RENEW_MS, settings, type Settings } from "./config";
import { iceServers, RealtimeSfu, SfuError, type TrackObject, type TracksResponse } from "./realtime";
import { claimsFromRequest, jsonError, tableExists, useToken } from "./shared";
import { KeyedQueue, closeSocket, parseIncoming, send, sendError, upgradeRequired } from "./socket";

type ViewerRow = {
  viewer_id: string;
  sfu_session_id: string | null;
  negotiating: number;
  pending_offer: string | null;
  created_at: number;
  socket_closed_at: number | null;
};

type SubscriptionRow = {
  viewer_id: string;
  mid: string;
  device_id: string;
  track_name: string;
  generation: number;
};

type ViewerAttachment = { viewerId: string; connectedAt: number };

export type AddMemberResult = { ok: true; viewers: number } | { ok: false; code: string; message: string };

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
    socket_closed_at INTEGER
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS subscriptions (
    viewer_id TEXT NOT NULL,
    mid TEXT NOT NULL,
    device_id TEXT NOT NULL,
    track_name TEXT NOT NULL,
    generation INTEGER NOT NULL,
    PRIMARY KEY (viewer_id, mid)
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = settings(env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ready = tableExists(ctx.storage.sql, "members");
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
          code: "room_full",
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
      this.broadcast({ action: "members", message: { devices: this.memberInfos() } });
    }
    return { ok: true, viewers };
  }

  async removeMember(deviceId: string): Promise<void> {
    if (!this.ready) return;
    this.sql.exec("DELETE FROM members WHERE device_id = ?", deviceId);
    this.sql.exec("DELETE FROM devices WHERE device_id = ?", deviceId);
    if (this.viewerCount() > 0) this.broadcast({ action: "members", message: { devices: this.memberInfos() } });
    await this.deleteIfEmpty();
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
    this.broadcast({ action: "device", message: info });
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
    for (const old of oldSockets) closeSocket(old, CLOSE_REPLACED, "Another connection uses the same viewer_id.");

    const wasEmpty = this.viewerCount() === 0;
    if (viewer) {
      this.sql.exec("UPDATE viewers SET socket_closed_at = NULL WHERE viewer_id = ?", viewerId);
    } else {
      this.sql.exec(
        `INSERT INTO viewers (viewer_id, sfu_session_id, negotiating, pending_offer, created_at, socket_closed_at)
         VALUES (?, NULL, 0, NULL, ?, NULL)`,
        viewerId,
        now,
      );
    }
    if (wasEmpty) await this.watchAll(now);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [viewerId]);
    server.serializeAttachment({ viewerId, connectedAt: now } satisfies ViewerAttachment);

    send(server, {
      action: "joined",
      message: {
        viewerId,
        room: this.roomId,
        resumed,
        iceServers: await iceServers(this.env),
        devices: this.memberInfos(),
        subscriptions: resumed ? this.subscriptions(viewerId) : [],
      },
    });
    // A viewer that dropped while an offer was pending gets the same offer again.
    if (resumed && viewer?.negotiating && viewer.pending_offer) {
      send(server, {
        action: "offer",
        message: { sdp: viewer.pending_offer, tracks: this.subscriptions(viewerId), sessionReset: false },
      });
    }
    await this.scheduleAlarm(now);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as ViewerAttachment | null;
    if (!attachment || !this.ready) return;
    const incoming = parseIncoming(data);
    if (!incoming) {
      sendError(ws, { code: "message_invalid", message: 'Send JSON like {"action": "...", "message": {...}}.' });
      return;
    }
    const { viewerId } = attachment;
    const run = (task: () => Promise<void>) =>
      this.queue.run(viewerId, async () => {
        if (!this.viewer(viewerId)) {
          sendError(ws, { code: "viewer_gone", message: "Join the room again.", action: incoming.action });
          return;
        }
        try {
          await task();
        } catch (error) {
          const code = error instanceof SfuError ? error.code : "internal_error";
          const message = error instanceof Error ? error.message : "Something went wrong.";
          console.log(JSON.stringify({ event: "viewer_action_failed", room: this.roomId, action: incoming.action, code }));
          sendError(ws, { code, message, action: incoming.action });
        }
      });
    switch (incoming.action) {
      case "subscribe":
        await run(() => this.onSubscribe(ws, viewerId, incoming.message));
        return;
      case "answer":
        await run(() => this.onAnswer(ws, viewerId, incoming.message));
        return;
      case "unsubscribe":
        await run(() => this.onUnsubscribe(ws, viewerId, incoming.message));
        return;
      case "leave":
        await run(async () => {
          await this.dropViewer(viewerId);
          closeSocket(ws, CLOSE_LEFT, "Left the room.");
        });
        return;
      default:
        sendError(ws, { code: "action_unknown", message: `Unknown action "${incoming.action}".`, action: incoming.action });
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

  private async onSubscribe(ws: WebSocket, viewerId: string, message: unknown): Promise<void> {
    const parsed = subscribeMessageSchema.safeParse(message);
    if (!parsed.success) {
      sendError(ws, { code: "subscribe_invalid", message: "subscribe needs tracks [{deviceId, trackName}].", action: "subscribe" });
      return;
    }
    const viewer = this.viewer(viewerId)!;
    if (viewer.negotiating) {
      sendError(ws, { code: "busy", message: "Send the answer for the last offer first.", action: "subscribe" });
      return;
    }

    const current = this.subscriptions(viewerId);
    const byDevice = new Map<string, Set<string>>();
    for (const track of parsed.data.tracks) {
      if (!this.isMember(track.deviceId)) {
        sendError(ws, {
          code: "not_member",
          message: `${track.deviceId} is not in this room.`,
          action: "subscribe",
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
      const subscribed = current.some((sub) => sub.deviceId === deviceId);
      const count = this.subscriberCount(deviceId) + (subscribed ? 0 : 1);
      const resolved = await this.env.DEVICES.getByName(deviceId).resolve(this.roomId, count);
      if (!resolved.ok) {
        sendError(ws, {
          code: resolved.code,
          message: resolved.message,
          action: "subscribe",
          deviceId,
          retryable: resolved.code === "not_live",
        });
        continue;
      }
      for (const trackName of names) {
        if (!resolved.tracks.includes(trackName)) {
          sendError(ws, {
            code: "track_not_found",
            message: `${deviceId} has no track ${trackName}.`,
            action: "subscribe",
            deviceId,
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
      send(ws, { action: "subscribed", message: { tracks: this.subscriptions(viewerId) } });
      return;
    }

    const sfu = new RealtimeSfu(this.env);
    let sessionId = viewer.sfu_session_id;
    let sessionReset = false;
    // The receive session is created on the first subscribe: an unused session can expire.
    if (!sessionId) sessionId = await this.newSession(sfu, viewerId);
    let result: TracksResponse;
    try {
      result = await sfu.addTracks(sessionId, remote);
    } catch (error) {
      if (!(error instanceof SfuError && error.sessionGone)) throw error;
      // The session expired. The viewer has to start a new PeerConnection for the new one.
      this.sql.exec("DELETE FROM subscriptions WHERE viewer_id = ?", viewerId);
      sessionId = await this.newSession(sfu, viewerId);
      sessionReset = true;
      result = await sfu.addTracks(sessionId, remote);
    }

    const returned = result.tracks ?? [];
    wanted.forEach((track, index) => {
      const item = returned[index];
      if (item?.errorCode || !item?.mid) {
        // Usually not_found_track_error: the device is connected but its media is not there yet.
        sendError(ws, {
          code: item?.errorCode ?? "track_failed",
          message: item?.errorDescription ?? `Could not pull ${track.trackName} from ${track.deviceId}.`,
          action: "subscribe",
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

  private async onAnswer(ws: WebSocket, viewerId: string, message: unknown): Promise<void> {
    const parsed = answerMessageSchema.safeParse(message);
    if (!parsed.success) {
      sendError(ws, { code: "answer_invalid", message: "answer needs an sdp.", action: "answer" });
      return;
    }
    const viewer = this.viewer(viewerId)!;
    if (!viewer.negotiating || !viewer.sfu_session_id) {
      sendError(ws, { code: "no_offer", message: "There is no offer waiting for an answer.", action: "answer" });
      return;
    }
    await new RealtimeSfu(this.env).renegotiate(viewer.sfu_session_id, parsed.data.sdp);
    this.sql.exec("UPDATE viewers SET negotiating = 0, pending_offer = NULL WHERE viewer_id = ?", viewerId);
    send(ws, { action: "subscribed", message: { tracks: this.subscriptions(viewerId) } });
  }

  private async onUnsubscribe(ws: WebSocket, viewerId: string, message: unknown): Promise<void> {
    const parsed = unsubscribeMessageSchema.safeParse(message);
    if (!parsed.success) {
      sendError(ws, { code: "unsubscribe_invalid", message: "unsubscribe needs mids.", action: "unsubscribe" });
      return;
    }
    const viewer = this.viewer(viewerId)!;
    if (viewer.negotiating) {
      sendError(ws, { code: "busy", message: "Send the answer for the last offer first.", action: "unsubscribe" });
      return;
    }
    const closing = this.subscriptions(viewerId).filter((sub) => parsed.data.mids.includes(sub.mid));
    if (closing.length === 0 || !viewer.sfu_session_id) {
      send(ws, { action: "subscribed", message: { tracks: this.subscriptions(viewerId) } });
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
    await this.updateCounts(new Set(closing.map((sub) => sub.deviceId)));
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
      send(ws, { action: "offer", message: { sdp: result.sessionDescription.sdp, tracks, sessionReset } });
      return;
    }
    send(ws, { action: "subscribed", message: { tracks } });
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
      closeSocket(ws, CLOSE_HEARTBEAT_TIMEOUT, "No ping received.");
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

  /** How many viewers in this room receive at least one track from the device. */
  private subscriberCount(deviceId: string): number {
    return this.sql
      .exec<{ n: number }>("SELECT COUNT(DISTINCT viewer_id) AS n FROM subscriptions WHERE device_id = ?", deviceId)
      .one().n;
  }

  private async watchAll(now: number): Promise<void> {
    const members = this.sql
      .exec<{ device_id: string }>("SELECT device_id FROM members")
      .toArray()
      .map((row) => row.device_id);
    await Promise.allSettled(members.map((deviceId) => this.watchDevice(deviceId, now)));
  }

  private async watchDevice(deviceId: string, now: number): Promise<void> {
    const result = await this.env.DEVICES.getByName(deviceId).watch(this.roomId, this.subscriberCount(deviceId));
    if (!result.member) {
      this.sql.exec("DELETE FROM members WHERE device_id = ?", deviceId);
      this.sql.exec("DELETE FROM devices WHERE device_id = ?", deviceId);
      if (this.viewerCount() > 0) this.broadcast({ action: "members", message: { devices: this.memberInfos() } });
      return;
    }
    const previous = this.sql
      .exec<{ info: string }>("SELECT info FROM devices WHERE device_id = ?", deviceId)
      .toArray()[0]?.info;
    const info = JSON.stringify(result.info);
    // Every viewer must see the same state, including changes found while renewing.
    if (previous !== undefined && previous !== info) this.broadcast({ action: "device", message: result.info });
    this.sql.exec(
      `INSERT INTO devices (device_id, info, lease_renewed_at) VALUES (?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET info = excluded.info, lease_renewed_at = excluded.lease_renewed_at`,
      deviceId,
      info,
      now,
    );
  }

  /** Reports new subscriber counts so each device can enforce its viewer limit. */
  private async updateCounts(deviceIds: Set<string>): Promise<void> {
    const now = Date.now();
    await Promise.allSettled([...deviceIds].map((deviceId) => this.watchDevice(deviceId, now)));
  }

  private async dropViewer(viewerId: string): Promise<void> {
    const affected = new Set(this.subscriptions(viewerId).map((sub) => sub.deviceId));
    this.sql.exec("DELETE FROM subscriptions WHERE viewer_id = ?", viewerId);
    this.sql.exec("DELETE FROM viewers WHERE viewer_id = ?", viewerId);
    if (this.viewerCount() > 0) {
      await this.updateCounts(affected);
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

  private broadcast(message: OutgoingMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN) send(ws, message);
    }
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

function offlineInfo(deviceId: string): DeviceInfo {
  return { deviceId, state: "offline", generation: 0, tracks: [], lastError: null };
}
