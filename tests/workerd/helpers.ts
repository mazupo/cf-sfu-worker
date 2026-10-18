import { exports as workerExports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { expect } from "vitest";

import { DeviceRequest, DeviceResponse, DeviceState, ViewerRequest, ViewerResponse } from "../../src/proto/cloudflare";
import { network } from "./network";

export const ORIGIN = "http://localhost";
// Public halves of the test keys in tests/workerd/wrangler.jsonc.
export const DEVICE_PUBLIC_KEY = "uZmXGgkcoF-pb1spp0_Vg1iq3BseHVP7xvSL-GioDJg";
export const VIEWER_PUBLIC_KEY = "0577et_UiSFMa5Xs_ukluiGj5gwD_3QTO71Uv0fLFAM";

const SFU = "https://rtc.live.cloudflare.com/v1/apps/test-app";

export function requestToken(key: string, body: unknown): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`${ORIGIN}/cloudflare/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function deviceToken(deviceId: string, rooms: string[], generation?: number): Promise<string> {
  const response = await requestToken(DEVICE_PUBLIC_KEY, {
    device_id: deviceId,
    room_ids: rooms,
    can_subscribe: false,
    ...(generation ? { generation } : {}),
  });
  expect(response.status).toBe(200);
  return (await response.json<{ token: string }>()).token;
}

export async function viewerToken(viewerId: string, room: string, dataChannels = false): Promise<string> {
  const response = await requestToken(VIEWER_PUBLIC_KEY, {
    viewer_id: viewerId,
    room_id: room,
    can_subscribe: true,
    ...(dataChannels ? { data_channels: true } : {}),
  });
  expect(response.status).toBe(200);
  return (await response.json<{ token: string }>()).token;
}

export async function openSocket(token: string): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`${ORIGIN}/cloudflare/rtc?access_token=${encodeURIComponent(token)}`, {
      headers: { Upgrade: "websocket" },
    }),
  );
}

export async function connect(token: string): Promise<TestSocket> {
  const response = await openSocket(token);
  expect(response.status).toBe(101);
  // The token's grant says whether this is a device or a viewer, which decides the messages.
  const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
  return new TestSocket(response.webSocket!, payload.grant.canPublish ? "device" : "viewer");
}

/** A decoded DeviceResponse or ViewerResponse: one field is set, e.g. `joined`. */
type Message = Record<string, any>;

/** Collects what a socket receives so tests can wait for a given message. */
export class TestSocket {
  readonly messages: Message[] = [];
  readonly texts: string[] = [];
  closeEvent: { code: number; reason: string } | null = null;
  private listeners: Array<() => void> = [];

  constructor(
    readonly ws: WebSocket,
    readonly role: "device" | "viewer",
  ) {
    ws.binaryType = "arraybuffer";
    ws.accept();
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        this.texts.push(event.data);
      } else {
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        const decoded = this.role === "device" ? DeviceResponse.decode(bytes) : ViewerResponse.decode(bytes);
        const set = Object.entries(decoded).filter(([, value]) => value !== undefined);
        this.messages.push(Object.fromEntries(set));
      }
      this.notify();
    });
    ws.addEventListener("close", (event) => {
      this.closeEvent = { code: event.code, reason: event.reason };
      this.notify();
    });
  }

  /** Sends a request, e.g. send("offer", {...}). Fields left out get their defaults. */
  send(request: string, message: Record<string, unknown> = {}): void {
    const partial: any = { [request]: message };
    const bytes =
      this.role === "device"
        ? DeviceRequest.encode(DeviceRequest.fromPartial(partial)).finish()
        : ViewerRequest.encode(ViewerRequest.fromPartial(partial)).finish();
    this.ws.send(bytes);
  }

  sendText(text: string): void {
    this.ws.send(text);
  }

  /** Waits for the next message of this kind (e.g. "joined") that has not been taken yet. */
  async next(kind: string, timeoutMs = 3000): Promise<any> {
    return this.waitFor(() => {
      const index = this.messages.findIndex((message) => message[kind] !== undefined);
      if (index < 0) return undefined;
      return this.messages.splice(index, 1)[0]![kind];
    }, timeoutMs, `message "${kind}"`);
  }

  async nextText(timeoutMs = 3000): Promise<string> {
    return this.waitFor(() => this.texts.shift(), timeoutMs, "a text frame");
  }

  async closed(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    return this.waitFor(() => this.closeEvent ?? undefined, timeoutMs, "close");
  }

  /** Waits for a `device` message in this state ("live", ...), skipping the ones before it. */
  async device(deviceId: string, stateName: string, timeoutMs = 3000): Promise<any> {
    const state = state_(stateName);
    return this.waitFor(() => {
      while (true) {
        const index = this.messages.findIndex((message) => message.device?.deviceId === deviceId);
        if (index < 0) return undefined;
        const [found] = this.messages.splice(index, 1);
        if (found!.device.state === state) return found!.device;
      }
    }, timeoutMs, `device ${deviceId} ${stateName}`);
  }

  has(kind: string): boolean {
    return this.messages.some((message) => message[kind] !== undefined);
  }

  close(): void {
    try {
      this.ws.close(1000, "test done");
    } catch {
      // already closed
    }
  }

  private notify(): void {
    for (const listener of this.listeners.splice(0)) listener();
  }

  private waitFor<T>(take: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}. Got: ${JSON.stringify(this.messages)}`)), timeoutMs);
      const check = () => {
        const value = take();
        if (value !== undefined) {
          clearTimeout(timer);
          resolve(value);
        } else {
          this.listeners.push(check);
        }
      };
      check();
    });
  }
}

export type SfuCall = { method: string; path: string; body: any };

/** Fakes the Realtime SFU API and records every call. */
export function mockSfu(options: { missingTrack?: string; expireFirstPublish?: boolean } = {}): SfuCall[] {
  const calls: SfuCall[] = [];
  let sessions = 0;
  let mids = 100;
  let publishes = 0;
  // Like the real SFU: channel ids per session, even for published ones and odd for pulled ones.
  const channelIds = new Map<string, { local: number; remote: number }>();
  const record = async (request: { method: string; url: string; text(): Promise<string>; headers: Headers }) => {
    const text = await request.text();
    const call = { method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null };
    calls.push(call);
    expect(request.headers.get("authorization")).toBe("Bearer test-sfu-token");
    return call;
  };
  network.use(
    http.post(`${SFU}/sessions/new`, async ({ request }) => {
      await record(request);
      sessions += 1;
      return HttpResponse.json({ sessionId: `session-${sessions}` }, { status: 201 });
    }),
    http.post(`${SFU}/sessions/:sessionId/tracks/new`, async ({ request }) => {
      const call = await record(request);
      const tracks = call.body.tracks as Array<{ location: string; mid?: string; trackName: string; sessionId?: string }>;
      if (tracks[0]?.location === "local") {
        if (options.expireFirstPublish && publishes++ === 0) {
          return HttpResponse.json({ errorCode: "session_error", errorDescription: "Session expired." }, { status: 410 });
        }
        return HttpResponse.json({
          sessionDescription: { type: "answer", sdp: "v=0 publisher-answer" },
          tracks: tracks.map((track) => ({ mid: track.mid, trackName: track.trackName })),
        });
      }
      return HttpResponse.json({
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: "offer", sdp: "v=0 subscriber-offer" },
        tracks: tracks.map((track) =>
          track.trackName === options.missingTrack
            ? {
                trackName: track.trackName,
                sessionId: track.sessionId,
                errorCode: "not_found_track_error",
                errorDescription: "Track not found on remote peer.",
              }
            : { mid: String(mids++), trackName: track.trackName, sessionId: track.sessionId },
        ),
      });
    }),
    http.put(`${SFU}/sessions/:sessionId/renegotiate`, async ({ request }) => {
      await record(request);
      return new HttpResponse(null, { status: 200 });
    }),
    http.post(`${SFU}/sessions/:sessionId/datachannels/establish`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({
        requiresImmediateRenegotiation: false,
        dataChannel: { dataChannelName: "server-events", id: 0 },
        sessionDescription: { type: "answer", sdp: "v=0 datachannel-answer" },
      });
    }),
    http.post(`${SFU}/sessions/:sessionId/datachannels/new`, async ({ request, params }) => {
      const call = await record(request);
      const next = channelIds.get(String(params.sessionId)) ?? { local: 2, remote: 1 };
      channelIds.set(String(params.sessionId), next);
      return HttpResponse.json({
        dataChannels: call.body.dataChannels.map((channel: { location: "local" | "remote" }) => {
          const id = next[channel.location];
          next[channel.location] += 2;
          return { ...channel, id };
        }),
      });
    }),
    http.put(`${SFU}/sessions/:sessionId/datachannels/update`, async ({ request }) => {
      const call = await record(request);
      return HttpResponse.json({ dataChannels: call.body.dataChannels });
    }),
    http.put(`${SFU}/sessions/:sessionId/datachannels/close`, async ({ request }) => {
      const call = await record(request);
      return HttpResponse.json({ dataChannels: call.body.dataChannels });
    }),
    http.put(`${SFU}/sessions/:sessionId/tracks/close`, async ({ request }) => {
      const call = await record(request);
      return HttpResponse.json({
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: "offer", sdp: "v=0 close-offer" },
        tracks: call.body.tracks,
      });
    }),
  );
  return calls;
}

/** The SFU session a call was made on, e.g. "session-2" for /sessions/session-2/tracks/new. */
export function sessionOf(call: SfuCall): string {
  return /\/sessions\/([^/]+)\//.exec(call.path)![1]!;
}

/** The session each device published on, by the order of the publish calls. */
export function publisherSessions(calls: SfuCall[]): string[] {
  return calls
    .filter((call) => call.path.endsWith("/tracks/new") && call.body.tracks[0].location === "local")
    .map(sessionOf);
}

export const PUBLISH_TRACKS = [
  { mid: "0", trackName: "video_track" },
  { mid: "1", trackName: "audio_track" },
];

/** "live" → DeviceState.DEVICE_STATE_LIVE */
export function state_(name: string): DeviceState {
  const state = DeviceState[`DEVICE_STATE_${name.toUpperCase()}` as keyof typeof DeviceState];
  if (state === undefined) throw new Error(`Unknown device state ${name}`);
  return state;
}
