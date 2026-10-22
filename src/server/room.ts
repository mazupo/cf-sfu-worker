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
  type Mute,
  type ReleaseControl,
  type Subscribe,
  type SubscribeAnswer,
  type SubscribeOffer,
  type Subscribed,
  type Subscription,
  type TakeControl,
  type Unsubscribe,
  type ViewerInfo,
  type ViewerResponse,
} from "../proto/cloudflare";
import {
  debugInfo,
  deviceIdMessageSchema,
  sdpMessageSchema,
  stateName,
  subscribeSchema,
  unsubscribeSchema,
  viewerOfferSchema,
} from "../shared/protocol";
import { REGISTRY_NAME, type RoomSummary } from "./registry";
import { MICROPHONE_TRACK, PRESENCE_CHECK_MS, WATCH_RENEW_MS, settings, type Settings } from "./config";
import type { RoomMicrophone } from "./device";
import { deviceChannels, iceServers, RealtimeSfu, SfuError, type TrackObject, type TracksResponse } from "./realtime";
import { claimsFromRequest, jsonError, tableExists, useToken } from "./shared";
import {
  KeyedQueue,
  closeSocket,
  decodeFrame,
  refuseSocket,
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
/** How long a dropped session's revoke goes first: the SFU must see it before the next grant. */
const REVOKE_HEAD_START_MS = 200;

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
  /** The microphone's mid in the viewer's own session, while it publishes one. */
  mic_mid: string | null;
  /** Counts microphone publications, so others can tell a new one from the last. */
  mic_generation: number;
  muted: number;
  /** 1 while its microphone offer waits for the SFU: it holds a place under the limit. */
  mic_pending: number;
  /** The hash of the secret it joined with. Only the same one resumes or replaces it. */
  secret_hash: string | null;
};

type DataSubscriptionRow = {
  viewer_id: string;
  device_id: string;
  generation: number;
  /** The device session the channels come from, needed to change canReply. */
  device_session: string;
  channels: string;
  can_reply: number;
};

type SubscriptionRow = {
  viewer_id: string;
  mid: string;
  /** Empty for another viewer's microphone. */
  device_id: string;
  track_name: string;
  generation: number;
  /** The viewer whose microphone this is. */
  mic_of: string | null;
};

type ViewerAttachment = { viewerId: string; connectedAt: number };

export type AddMemberResult =
  | { ok: true; viewers: number; microphones: RoomMicrophone[] }
  | { ok: false; code: ErrorCode; message: string };

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
    data_transport INTEGER NOT NULL,
    mic_mid TEXT,
    mic_generation INTEGER NOT NULL DEFAULT 0,
    muted INTEGER NOT NULL DEFAULT 0,
    mic_pending INTEGER NOT NULL DEFAULT 0,
    secret_hash TEXT
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS subscriptions (
    viewer_id TEXT NOT NULL,
    mid TEXT NOT NULL,
    device_id TEXT NOT NULL,
    track_name TEXT NOT NULL,
    generation INTEGER NOT NULL,
    mic_of TEXT,
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

/** One per room_id: its members, and its viewers' sockets, SFU sessions and subscriptions. */
export class Room extends DurableObject<Env> {
  private readonly config: Settings;
  private readonly queue = new KeyedQueue();
  /** The tables exist only while the room has members or viewers. */
  private ready: boolean;
  /** Receive sessions started at join, by viewer_id. The first subscribe takes one. */
  private readonly earlySessions = new Map<string, Promise<string | null>>();
  /** A report to the Registry is on its way for this burst of changes. */
  private reportQueued = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = settings(env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ready = tableExists(ctx.storage.sql, "members");
    if (this.ready) {
      addMissingColumns(ctx.storage.sql);
      // A new instance runs no request, so no microphone offer waits.
      ctx.storage.sql.exec("UPDATE viewers SET mic_pending = 0 WHERE mic_pending = 1");
    }
    // A deploy drops sockets without a close. No sockets: the viewers are away from now, so they can resume.
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

  // RPC from Device

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
    this.reportSoon();
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
    // The device plays these voices, if it plays any.
    return { ok: true, viewers, microphones: this.microphones() };
  }

  async removeMember(deviceId: string): Promise<void> {
    if (!this.ready) return;
    this.forgetDevice(deviceId);
    this.reportSoon();
    if (this.viewerCount() > 0) this.broadcast({ members: { devices: this.memberInfos() } });
    await this.deleteIfEmpty();
  }

  /** The device hands its control to this viewer. False when the viewer cannot take it. */
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

  /** Takes canReply back, e.g. the viewer did not confirm in time. */
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

  /** Returns whether this room still wants the device's updates. */
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

  // Viewer socket

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

    // Asked first: between closing the old socket and accepting this one, only watchAll() may wait.
    const ice = await iceServers(this.env);

    const viewerId = claims.sub;
    let viewer = this.viewer(viewerId);
    if (viewer) {
      // Someone else with this viewer ID. It gets the ID once the other one is gone.
      const sameClient = viewer.secret_hash === null || viewer.secret_hash === claims.grant.secretHash;
      if (!sameClient && this.viewerAlive(viewerId, now)) {
        console.log(JSON.stringify({ event: "viewer_id_in_use", room: this.roomId, viewerId }));
        return refuseSocket(CloseCode.CLOSE_CODE_ID_IN_USE, "Another live connection uses this viewer_id.");
      }
      const resumable =
        sameClient &&
        (this.ctx.getWebSockets(viewerId).length > 0 ||
          (viewer.socket_closed_at !== null && now - viewer.socket_closed_at <= this.config.viewerResumeMs));
      if (!resumable) {
        await this.dropViewer(viewerId);
      } else if (viewer.data_channels && !claims.grant.dataChannels) {
        // Resumed without data channels: give up control, and let the SFU close them in the background.
        await this.dropData(viewerId);
      }
      viewer = this.viewer(viewerId);
    }
    const resumed = viewer !== null;
    for (const old of this.ctx.getWebSockets(viewerId)) {
      closeSocket(old, CloseCode.CLOSE_CODE_REPLACED, "Another connection uses the same viewer_id.");
    }

    const wasEmpty = this.viewerCount() === 0;
    if (viewer) {
      this.sql.exec(
        "UPDATE viewers SET socket_closed_at = NULL, data_channels = ?, secret_hash = ? WHERE viewer_id = ?",
        claims.grant.dataChannels ? 1 : 0,
        claims.grant.secretHash,
        viewerId,
      );
    } else {
      this.sql.exec(
        `INSERT INTO viewers (viewer_id, sfu_session_id, negotiating, pending_offer, created_at, socket_closed_at,
           data_channels, data_transport, secret_hash)
         VALUES (?, NULL, 0, NULL, ?, NULL, ?, ?, ?)`,
        viewerId,
        now,
        claims.grant.dataChannels ? 1 : 0,
        DATA_NONE,
        claims.grant.secretHash,
      );
    }
    // Devices are waking now. Create the receive session meanwhile, saving the first subscribe an SFU call.
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
        iceServers: ice,
        devices: this.memberInfos(),
        subscriptions: resumed ? this.subscriptions(viewerId) : [],
        data: resumed ? this.dataSubscriptions(viewerId) : [],
        viewers: this.viewerInfos(),
      },
    });
    this.broadcastViewers(server);
    // A viewer that dropped with an offer pending gets it again.
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
    if (!attachment || !this.ready) return;
    const request = decodeFrame(ViewerRequest, data);
    const name = request ? requestName(request) : "";
    // The page leaves and closes the socket at once, so only a leave still counts once it is closing.
    if (ws.readyState !== WebSocket.OPEN && !request?.leave) return;
    if (!request || !name) {
      this.fail(ws, ErrorCode.ERROR_CODE_INVALID_MESSAGE, "Send a binary ViewerRequest.", name);
      return;
    }
    const { viewerId } = attachment;
    const run = (task: () => Promise<void>) =>
      this.queue.run(viewerId, async () => {
        // What a replaced socket sends, e.g. a late leave, belongs to the old connection.
        if (this.replaced(ws, attachment)) return;
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
    const { subscribe, answer, unsubscribe, leave, takeControl, releaseControl, controlReady, offer, mute } = request;
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
    } else if (mute) {
      await run(async () => this.onMute(viewerId, mute));
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
    const viewer = this.viewer(attachment.viewerId);
    // Gone, or an older socket of this ID that someone else took over.
    if (!viewer || attachment.connectedAt < viewer.created_at) return;
    const now = Date.now();
    this.sql.exec(
      "UPDATE viewers SET socket_closed_at = COALESCE(socket_closed_at, ?) WHERE viewer_id = ?",
      now,
      attachment.viewerId,
    );
    this.broadcastViewers();
    await this.scheduleAlarm(now);
  }

  private async onSubscribe(ws: WebSocket, viewerId: string, message: Subscribe): Promise<void> {
    const parsed = subscribeSchema.safeParse(message);
    if (!parsed.success) {
      this.fail(ws, ErrorCode.ERROR_CODE_INVALID_MESSAGE, "subscribe needs tracks [{deviceId, trackName}], data [deviceId] or microphones [viewerId].", "subscribe");
      return;
    }
    const viewer = this.viewer(viewerId)!;
    if (viewer.negotiating) {
      this.fail(ws, ErrorCode.ERROR_CODE_BUSY, "Send the answer for the last offer first.", "subscribe");
      return;
    }
    // Data channels need no SDP, so they go first and the media offer comes last.
    if (parsed.data.data.length > 0) await this.subscribeData(ws, viewer, parsed.data.data);
    if (parsed.data.tracks.length === 0 && parsed.data.microphones.length === 0) {
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
    const wanted: Array<{ deviceId: string; trackName: string; generation: number; micOf?: string }> = [];
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
    // Other viewers' microphones, pulled from their own sessions.
    for (const micOf of new Set(parsed.data.microphones)) {
      const speaker = micOf === viewerId ? null : this.viewer(micOf);
      if (!speaker?.mic_mid || !speaker.sfu_session_id) {
        this.failTrack(ws, {
          code: ErrorCode.ERROR_CODE_TRACK_NOT_FOUND,
          message: `${micOf} has no microphone in this room.`,
          viewerId: micOf,
        });
        continue;
      }
      const duplicate = current.some((sub) => sub.viewerId === micOf && sub.generation === speaker.mic_generation);
      if (duplicate) continue;
      remote.push({ location: "remote", sessionId: speaker.sfu_session_id, trackName: MICROPHONE_TRACK });
      wanted.push({ deviceId: "", trackName: MICROPHONE_TRACK, generation: speaker.mic_generation, micOf });
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
      // The session expired, e.g. made at join and idle for long. The viewer starts a new PeerConnection.
      this.forgetSession(viewerId);
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
          ...(track.micOf ? { viewerId: track.micOf } : { deviceId: track.deviceId }),
          trackName: track.trackName,
          retryable: true,
        });
        return;
      }
      const mid = item.mid;
      this.sql.exec(
        `INSERT OR REPLACE INTO subscriptions (viewer_id, mid, device_id, track_name, generation, mic_of)
         VALUES (?, ?, ?, ?, ?, ?)`,
        viewerId,
        mid,
        track.deviceId,
        track.trackName,
        track.generation,
        track.micOf ?? null,
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

  /** The viewer's own offer, with only m=application. One SFU call, and it connects while the devices wake. */
  private async onViewerOffer(ws: WebSocket, viewerId: string, message: SubscribeOffer): Promise<void> {
    const parsed = viewerOfferSchema.safeParse(message);
    if (!parsed.success) {
      this.fail(ws, ErrorCode.ERROR_CODE_INVALID_MESSAGE, "offer needs an sdp, and tracks only for the microphone.", "offer");
      return;
    }
    const microphone = parsed.data.tracks[0];
    if (microphone) {
      await this.onMicrophone(ws, viewerId, parsed.data.sdp, microphone.mid);
      return;
    }
    let viewer = this.viewer(viewerId)!;
    if (viewer.data_transport === DATA_READY || viewer.negotiating) {
      // The last PeerConnection failed: a new session, and the viewer subscribes again.
      this.forgetSession(viewerId);
      viewer = this.viewer(viewerId)!;
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
      // A session made at join can expire before the offer. One with tracks cannot be replaced here.
      if (!(error instanceof SfuError && error.sessionGone) || this.subscriptions(viewerId).length > 0) throw error;
      sessionId = await this.newSession(sfu, viewerId);
      answer = await sfu.establishDataChannels(sessionId, parsed.data.sdp);
    }
    this.sql.exec("UPDATE viewers SET data_transport = ? WHERE viewer_id = ?", DATA_READY, viewerId);
    sendViewer(ws, { answer: { sdp: answer.sdp } });
  }

  /** Publishes the viewer's microphone: its offer with the microphone in `tracks`. `mute` set the start state. */
  private async onMicrophone(ws: WebSocket, viewerId: string, sdp: string, mid: string): Promise<void> {
    const viewer = this.viewer(viewerId)!;
    if (viewer.data_transport !== DATA_READY || !viewer.sfu_session_id) {
      this.failMicrophone(ws, ErrorCode.ERROR_CODE_BUSY, "Send your own offer first.");
      return;
    }
    if (viewer.negotiating) {
      this.failMicrophone(ws, ErrorCode.ERROR_CODE_BUSY, "Send the answer for the last offer first.");
      return;
    }
    if (viewer.mic_mid) {
      this.failMicrophone(ws, ErrorCode.ERROR_CODE_BUSY, "This PeerConnection already publishes a microphone.");
      return;
    }
    // Offers still waiting for the SFU count too: two viewers' queues can be here at once.
    const speakers = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM viewers WHERE mic_mid IS NOT NULL OR mic_pending = 1")
      .one().n;
    if (speakers >= this.config.maxMicrophonesPerRoom) {
      this.failMicrophone(
        ws,
        ErrorCode.ERROR_CODE_MICROPHONE_LIMIT,
        `Room ${this.roomId} already has ${this.config.maxMicrophonesPerRoom} microphones. You can listen.`,
      );
      return;
    }
    this.sql.exec("UPDATE viewers SET mic_pending = 1 WHERE viewer_id = ?", viewerId);
    let answer: string;
    try {
      const result = await new RealtimeSfu(this.env).addTracks(
        viewer.sfu_session_id,
        [{ location: "local", mid, trackName: MICROPHONE_TRACK }],
        { type: "offer", sdp },
      );
      const track = result.tracks?.[0];
      if (track?.errorCode || result.sessionDescription?.type !== "answer") {
        throw new SfuError(
          track?.errorCode ?? "sfu_answer_missing",
          track?.errorDescription ?? "The SFU did not answer the microphone offer.",
          502,
        );
      }
      answer = result.sessionDescription.sdp;
    } finally {
      this.sql.exec("UPDATE viewers SET mic_pending = 0 WHERE viewer_id = ?", viewerId);
    }
    this.sql.exec(
      "UPDATE viewers SET mic_mid = ?, mic_generation = mic_generation + 1 WHERE viewer_id = ?",
      mid,
      viewerId,
    );
    sendViewer(ws, { answer: { sdp: answer } });
    this.broadcastViewers();
    this.tellDevicesSoon();
  }

  /** Before a microphone is published, it sets the state the microphone starts in. */
  private onMute(viewerId: string, message: Mute): void {
    this.sql.exec("UPDATE viewers SET muted = ? WHERE viewer_id = ?", message.muted ? 1 : 0, viewerId);
    if (this.viewer(viewerId)?.mic_mid) this.broadcastViewers();
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

  /** Closes the viewer's channels to these devices. A controller gives up control. */
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

  /** Closes the viewer's channels to a device and gives up canReply. Both at once: each can take ~5 s. */
  private async closeData(sfu: RealtimeSfu, sessionId: string, sub: DataSubscriptionRow): Promise<void> {
    const ids = (JSON.parse(sub.channels) as DataChannel[]).map((channel) => channel.id);
    await Promise.allSettled([
      sub.can_reply ? sfu.updateDataChannels(sessionId, deviceChannels("remote", sub.device_session, false)) : undefined,
      sfu.closeDataChannels(sessionId, ids),
    ]);
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
    // Stop this viewer's messages before the next one takes over. On an SFU failure, give up control anyway.
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

  /** Sends the SFU's offer when it needs an answer, else confirms the subscriptions. */
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

  // Alarm

  override async alarm(): Promise<void> {
    if (!this.ready) return;
    const now = Date.now();
    this.sql.exec("DELETE FROM used_tokens WHERE expires_at <= ?", now);

    // Half-open sockets: the socket exists but pings stopped.
    let wentAway = false;
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
        wentAway = true;
      }
    }
    if (wentAway) this.broadcastViewers();

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

    // Keep telling the devices that this room still watches.
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

    this.reportSoon();
    if (await this.deleteIfEmpty()) return;
    await this.scheduleAlarm(now);
  }

  // Helpers

  /** Everything this object holds, for the debug page. Includes SFU session IDs. */
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
        microphone: viewer.mic_mid ? { mid: viewer.mic_mid, generation: viewer.mic_generation, muted: Boolean(viewer.muted) } : null,
      })),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  /** One of the viewer's sockets is open and was pinged lately. */
  private viewerAlive(viewerId: string, now: number): boolean {
    return this.ctx
      .getWebSockets(viewerId)
      .some((ws) => ws.readyState === WebSocket.OPEN && now - this.lastSeen(ws) <= this.config.viewerStaleMs);
  }

  /** Another socket took the viewer over, or the viewer left and joined anew after this socket opened. */
  private replaced(ws: WebSocket, attachment: ViewerAttachment): boolean {
    const viewer = this.viewer(attachment.viewerId);
    if (viewer && attachment.connectedAt < viewer.created_at) return true;
    return this.ctx.getWebSockets(attachment.viewerId).some((other) => other !== ws && other.readyState === WebSocket.OPEN);
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
      .map((row) => ({
        deviceId: row.device_id,
        trackName: row.track_name,
        mid: row.mid,
        generation: row.generation,
        viewerId: row.mic_of ?? "",
        // Only a device's pull of a microphone needs the room.
        room: "",
      }));
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

  /** Viewers here that receive a track or the data channels of the device. */
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

  /** The device counts a viewer from its first resolve, and stops once the viewer gets nothing from it. */
  private async releaseViewer(viewerId: string, deviceIds: Iterable<string>): Promise<void> {
    // A microphone's subscription has no device.
    const done = [...new Set(deviceIds)].filter((deviceId) => deviceId && !this.isSubscribedTo(viewerId, deviceId));
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
    // Its tracks stay until each viewer unsubscribes. Generation 0 never matches its new tracks.
    this.sql.exec("UPDATE subscriptions SET generation = 0 WHERE device_id = ?", deviceId);
  }

  /** Gives up the viewer's control, and closes its data channels in the background. */
  private async dropData(viewerId: string): Promise<void> {
    const subs = this.sql.exec<DataSubscriptionRow>("SELECT * FROM data_subscriptions WHERE viewer_id = ?", viewerId).toArray();
    const sessionId = this.viewer(viewerId)?.sfu_session_id;
    if (sessionId) void this.closeAllData(sessionId, subs);
    this.sql.exec("DELETE FROM data_subscriptions WHERE viewer_id = ?", viewerId);
    await Promise.allSettled(subs.map((sub) => this.env.DEVICES.getByName(sub.device_id).controlGone(this.roomId, viewerId)));
  }

  private async closeAllData(sessionId: string, subs: DataSubscriptionRow[]): Promise<void> {
    const sfu = new RealtimeSfu(this.env);
    await Promise.allSettled(subs.map((sub) => this.closeData(sfu, sessionId, sub)));
  }

  /** Takes canReply back from a dropped session before the next grant, or the SFU holds that grant ~5 s. Its channels stay: closing only waits ~5 s for an error. */
  private async revokeFirst(sessionId: string | null | undefined, subs: DataSubscriptionRow[]): Promise<void> {
    const held = subs.filter((sub) => sub.can_reply);
    if (!sessionId || held.length === 0) return;
    const sfu = new RealtimeSfu(this.env);
    const revoking = Promise.allSettled(held.map((sub) => sfu.updateDataChannels(sessionId, deviceChannels("remote", sub.device_session, false))));
    // A gone session answers only after ~5 s; the SFU just has to see this first.
    await Promise.race([revoking, new Promise((resolve) => setTimeout(resolve, REVOKE_HEAD_START_MS))]);
  }

  /** The viewer's PeerConnection and session are done. It keeps control and counts, and subscribes again. */
  private forgetSession(viewerId: string): void {
    const viewer = this.viewer(viewerId);
    const hadMicrophone = Boolean(viewer?.mic_mid);
    const subs = this.sql.exec<DataSubscriptionRow>("SELECT * FROM data_subscriptions WHERE viewer_id = ?", viewerId).toArray();
    void this.revokeFirst(viewer?.sfu_session_id, subs);
    this.sql.exec("DELETE FROM data_subscriptions WHERE viewer_id = ?", viewerId);
    this.sql.exec("DELETE FROM subscriptions WHERE viewer_id = ?", viewerId);
    this.sql.exec(
      `UPDATE viewers SET sfu_session_id = NULL, negotiating = 0, pending_offer = NULL, data_transport = ?, mic_mid = NULL
       WHERE viewer_id = ?`,
      DATA_NONE,
      viewerId,
    );
    // Its microphone went with the session. Others unsubscribe, and pull the next one.
    if (hadMicrophone) {
      this.broadcastViewers();
      this.tellDevicesSoon();
    }
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

  /** Deletes the viewer before any wait, so a join meanwhile starts anew. */
  private async dropViewer(viewerId: string): Promise<void> {
    this.earlySessions.delete(viewerId);
    const viewer = this.viewer(viewerId);
    const data = this.sql.exec<DataSubscriptionRow>("SELECT * FROM data_subscriptions WHERE viewer_id = ?", viewerId).toArray();
    const affected = new Set([...this.subscriptions(viewerId).map((sub) => sub.deviceId), ...data.map((sub) => sub.device_id)]);
    this.sql.exec("DELETE FROM data_subscriptions WHERE viewer_id = ?", viewerId);
    this.sql.exec("DELETE FROM subscriptions WHERE viewer_id = ?", viewerId);
    this.sql.exec("DELETE FROM viewers WHERE viewer_id = ?", viewerId);
    // Others' pulls of its microphone stay until they unsubscribe. Generation 0 never matches a new one.
    this.sql.exec("UPDATE subscriptions SET generation = 0 WHERE mic_of = ?", viewerId);
    this.broadcastViewers();
    if (viewer?.mic_mid) this.tellDevicesSoon();
    const members = this.sql
      .exec<{ device_id: string }>("SELECT device_id FROM members")
      .toArray()
      .map((row) => row.device_id);
    await this.revokeFirst(viewer?.sfu_session_id, data);
    // Between PeerConnections it has no channels but may still control a device, so each device drops it.
    if (viewer?.data_channels) {
      await Promise.allSettled(members.map((deviceId) => this.env.DEVICES.getByName(deviceId).controlGone(this.roomId, viewerId)));
    }
    if (this.viewerCount() > 0) {
      await this.releaseViewer(viewerId, affected);
      return;
    }
    // Nobody watches any more. Each device sleeps after its linger time.
    this.sql.exec("DELETE FROM devices");
    await Promise.allSettled(members.map((deviceId) => this.env.DEVICES.getByName(deviceId).unwatch(this.roomId)));
  }

  /** Sends to the viewer's open sockets: one, unless a replaced one is still closing. */
  private sendTo(viewerId: string, message: ViewerResponse): void {
    for (const ws of this.ctx.getWebSockets(viewerId)) {
      if (ws.readyState === WebSocket.OPEN) sendViewer(ws, message);
    }
  }

  private broadcast(message: ViewerResponse, except?: WebSocket): void {
    // The dashboard wants whatever viewers hear about.
    this.reportSoon();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except && ws.readyState === WebSocket.OPEN) sendViewer(ws, message);
    }
  }

  /** Tells the Registry what this room holds, once per burst of changes. Best effort. */
  private reportSoon(): void {
    if (this.reportQueued) return;
    this.reportQueued = true;
    setTimeout(() => {
      this.reportQueued = false;
      this.env.REGISTRY.getByName(REGISTRY_NAME)
        .report(this.roomId, this.summary())
        .catch(() => undefined);
    }, 0);
  }

  /** For the Registry. Null once the room is empty. */
  private summary(): RoomSummary | null {
    if (!this.ready) return null;
    const viewers = this.sql
      .exec<{ data_channels: number; socket_closed_at: number | null }>("SELECT data_channels, socket_closed_at FROM viewers")
      .toArray();
    // The room knows a device's state only while someone watches.
    const devices = this.sql
      .exec<{ device_id: string; info: string | null }>(
        "SELECT m.device_id, d.info FROM members m LEFT JOIN devices d ON d.device_id = m.device_id ORDER BY m.device_id",
      )
      .toArray()
      .map((row) => ({ deviceId: row.device_id, state: row.info ? stateName((JSON.parse(row.info) as DeviceInfo).state) : null }));
    if (viewers.length === 0 && devices.length === 0) return null;
    return {
      viewers: viewers.filter((viewer) => viewer.socket_closed_at === null).length,
      away: viewers.filter((viewer) => viewer.socket_closed_at !== null).length,
      ipcViewers: viewers.filter((viewer) => viewer.data_channels).length,
      devices,
    };
  }

  /** Everyone in the room, oldest first, as the viewers see them. */
  private viewerInfos(): ViewerInfo[] {
    return this.sql
      .exec<Pick<ViewerRow, "viewer_id" | "data_channels" | "socket_closed_at" | "mic_mid" | "mic_generation" | "muted">>(
        `SELECT viewer_id, data_channels, socket_closed_at, mic_mid, mic_generation, muted FROM viewers
         ORDER BY created_at, viewer_id`,
      )
      .toArray()
      .map((row) => ({
        viewerId: row.viewer_id,
        dataChannels: Boolean(row.data_channels),
        away: row.socket_closed_at !== null,
        microphone: row.mic_mid !== null,
        muted: Boolean(row.muted),
        microphoneGeneration: row.mic_generation,
      }));
  }

  /** The microphones the room's devices play: every viewer's that publishes one. */
  private microphones(): RoomMicrophone[] {
    return this.sql
      .exec<Pick<ViewerRow, "viewer_id" | "sfu_session_id" | "mic_generation">>(
        `SELECT viewer_id, sfu_session_id, mic_generation FROM viewers
         WHERE mic_mid IS NOT NULL AND sfu_session_id IS NOT NULL ORDER BY created_at, viewer_id`,
      )
      .toArray()
      .map((row) => ({ viewerId: row.viewer_id, sessionId: row.sfu_session_id!, generation: row.mic_generation }));
  }

  /** Tells every device which microphones to play, in the background. The key has a colon, unlike viewer IDs. */
  private tellDevicesSoon(): void {
    void this.queue.run("devices:voices", async () => {
      if (!this.ready) return;
      const microphones = this.microphones();
      const members = this.sql
        .exec<{ device_id: string }>("SELECT device_id FROM members")
        .toArray()
        .map((row) => row.device_id);
      await Promise.allSettled(members.map((deviceId) => this.env.DEVICES.getByName(deviceId).hear(this.roomId, microphones)));
    });
  }

  /** Tells the viewers who is in the room. `except` already knows, e.g. from its joined. */
  private broadcastViewers(except?: WebSocket): void {
    this.broadcast({ viewers: { viewers: this.viewerInfos() } }, except);
  }

  private fail(ws: WebSocket, code: ErrorCode, message: string, request: string): void {
    sendViewer(ws, { error: signalError({ code, message, request }) });
  }

  private failControl(ws: WebSocket, code: ErrorCode, message: string, deviceId: string, request: string): void {
    sendViewer(ws, { error: signalError({ code, message, request, deviceId }) });
  }

  /** A microphone offer failed: the viewer rolls it back and only listens, or tries later. */
  private failMicrophone(ws: WebSocket, code: ErrorCode, message: string): void {
    sendViewer(ws, { error: signalError({ code, message, request: "offer", trackName: MICROPHONE_TRACK }) });
  }

  /** An error for one device, track or microphone of a subscribe. The rest goes on. */
  private failTrack(
    ws: WebSocket,
    fields: { code: ErrorCode; message: string; deviceId?: string; viewerId?: string; trackName?: string; retryable?: boolean },
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
    this.reportSoon();
    return true;
  }
}

/** For the debug view: away (may still resume), joined (no SFU session yet) or ready. */
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

/** Tables made before the microphone columns get them. */
function addMissingColumns(sql: SqlStorage): void {
  const columns = (table: string) =>
    new Set(sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray().map((row) => row.name));
  const viewers = columns("viewers");
  if (!viewers.has("mic_mid")) sql.exec("ALTER TABLE viewers ADD COLUMN mic_mid TEXT");
  if (!viewers.has("mic_generation")) sql.exec("ALTER TABLE viewers ADD COLUMN mic_generation INTEGER NOT NULL DEFAULT 0");
  if (!viewers.has("muted")) sql.exec("ALTER TABLE viewers ADD COLUMN muted INTEGER NOT NULL DEFAULT 0");
  if (!viewers.has("mic_pending")) sql.exec("ALTER TABLE viewers ADD COLUMN mic_pending INTEGER NOT NULL DEFAULT 0");
  if (!viewers.has("secret_hash")) sql.exec("ALTER TABLE viewers ADD COLUMN secret_hash TEXT");
  if (!columns("subscriptions").has("mic_of")) sql.exec("ALTER TABLE subscriptions ADD COLUMN mic_of TEXT");
}
