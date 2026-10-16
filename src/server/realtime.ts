import type { IceServer } from "../proto/cloudflare";

const SFU_BASE = "https://rtc.live.cloudflare.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_ICE_SERVERS: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"], username: "", credential: "" }];

export class SfuError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SfuError";
  }

  /** The session no longer exists, so the caller has to start a new one. */
  get sessionGone(): boolean {
    return this.status === 404 || this.status === 410;
  }
}

export type SessionDescription = { type: "offer" | "answer"; sdp: string };

export type TrackObject = {
  location: "local" | "remote";
  mid?: string;
  sessionId?: string;
  trackName: string;
};

export type TracksResponse = {
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: SessionDescription;
  tracks?: Array<{ mid?: string; trackName?: string; sessionId?: string; errorCode?: string; errorDescription?: string }>;
};

/**
 * The Realtime SFU API. The bearer token is the app secret, so this client only ever runs
 * inside the Worker and its Durable Objects.
 */
export class RealtimeSfu {
  private readonly base: string;
  private readonly token: string;

  constructor(env: Env) {
    const appId = env.REALTIME_SFU_APP_ID?.trim();
    const token = env.REALTIME_SFU_BEARER_TOKEN?.trim();
    if (!appId || !token) {
      throw new SfuError("sfu_not_configured", "REALTIME_SFU_APP_ID and REALTIME_SFU_BEARER_TOKEN must be set.", 503);
    }
    this.base = `${SFU_BASE}/apps/${encodeURIComponent(appId)}`;
    this.token = token;
  }

  async createSession(): Promise<string> {
    const body = await this.request<{ sessionId?: string }>("POST", "/sessions/new");
    if (!body.sessionId) throw new SfuError("sfu_session_invalid", "The SFU did not return a session ID.", 502);
    return body.sessionId;
  }

  async addTracks(
    sessionId: string,
    tracks: TrackObject[],
    sessionDescription?: SessionDescription,
  ): Promise<TracksResponse> {
    const body = await this.request<TracksResponse>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/tracks/new`,
      sessionDescription ? { sessionDescription, tracks } : { tracks },
    );
    // Per-track errors stay in the response. The other tracks may have succeeded, and the
    // response can still carry an offer that has to be answered.
    return body;
  }

  async closeTracks(sessionId: string, mids: string[]): Promise<TracksResponse> {
    return this.request<TracksResponse>("PUT", `/sessions/${encodeURIComponent(sessionId)}/tracks/close`, {
      force: true,
      tracks: mids.map((mid) => ({ mid })),
    });
  }

  async renegotiate(sessionId: string, sdp: string): Promise<void> {
    await this.request("PUT", `/sessions/${encodeURIComponent(sessionId)}/renegotiate`, {
      sessionDescription: { type: "answer", sdp },
    });
  }

  private async request<T>(method: "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw controller.signal.aborted
        ? new SfuError("sfu_timeout", "The SFU did not answer in time.", 504)
        : new SfuError("sfu_unreachable", "The SFU could not be reached.", 503);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new SfuError("sfu_response_invalid", "The SFU returned a response that is not JSON.", 502);
      }
    }
    // The SFU can report an error inside a 2xx response.
    const errorCode = typeof parsed.errorCode === "string" ? parsed.errorCode : undefined;
    if (!response.ok || errorCode) {
      throw new SfuError(
        errorCode ?? `sfu_http_${response.status}`,
        typeof parsed.errorDescription === "string" ? parsed.errorDescription : `The SFU answered ${response.status}.`,
        response.ok ? 502 : response.status,
      );
    }
    return parsed as T;
  }
}

/** TURN credentials last a day. Everyone in this isolate shares them for an hour. */
const TURN_TTL_SECONDS = 86_400;
const TURN_REUSE_MS = 60 * 60 * 1000;
let turnCache: { keyId: string; servers: IceServer[]; expiresAt: number } | null = null;

/** STUN, plus short-lived TURN credentials when a TURN key is configured. */
export async function iceServers(env: Env): Promise<IceServer[]> {
  const keyId = env.REALTIME_TURN_KEY_ID?.trim();
  const apiToken = env.REALTIME_TURN_KEY_API_TOKEN?.trim();
  if (!keyId || !apiToken) return DEFAULT_ICE_SERVERS;
  const now = Date.now();
  if (turnCache?.keyId === keyId && turnCache.expiresAt > now) return turnCache.servers;
  const servers = await turnServers(keyId, apiToken);
  // Only good answers are kept, so the next join asks again after a failure.
  if (servers) turnCache = { keyId, servers, expiresAt: now + TURN_REUSE_MS };
  return servers ?? DEFAULT_ICE_SERVERS;
}

/** Asks the TURN API for credentials. Null when it fails or takes too long: joins wait for it. */
async function turnServers(keyId: string, apiToken: string): Promise<IceServer[] | null> {
  try {
    const response = await fetch(
      `${SFU_BASE}/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    type TurnServer = { urls: string | string[]; username?: string; credential?: string };
    const body = await response.json<{ iceServers?: TurnServer[] | TurnServer }>();
    const servers = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
    // Browsers time out on port 53, so leave those URLs out.
    const usable = servers
      .map((server) => ({
        urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => !/:53(\?|$)/.test(url)),
        username: server.username ?? "",
        credential: server.credential ?? "",
      }))
      .filter((server) => server.urls.length > 0);
    return usable.length > 0 ? usable : null;
  } catch {
    return null;
  }
}
