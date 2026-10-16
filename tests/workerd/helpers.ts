import { exports as workerExports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { expect } from "vitest";

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

export async function deviceToken(deviceId: string, rooms: string[], wakeId?: string): Promise<string> {
  const response = await requestToken(DEVICE_PUBLIC_KEY, {
    device_id: deviceId,
    room_ids: rooms,
    can_subscribe: false,
    ...(wakeId ? { wake_id: wakeId } : {}),
  });
  expect(response.status).toBe(200);
  return (await response.json<{ token: string }>()).token;
}

export async function viewerToken(viewerId: string, room: string): Promise<string> {
  const response = await requestToken(VIEWER_PUBLIC_KEY, { viewer_id: viewerId, room_id: room, can_subscribe: true });
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
  return new TestSocket(response.webSocket!);
}

type Message = { action: string; message: any };

/** Collects what a socket receives so tests can wait for a given action. */
export class TestSocket {
  readonly messages: Message[] = [];
  readonly texts: string[] = [];
  closeEvent: { code: number; reason: string } | null = null;
  private listeners: Array<() => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (event) => {
      const data = String(event.data);
      try {
        this.messages.push(JSON.parse(data) as Message);
      } catch {
        this.texts.push(data);
      }
      this.notify();
    });
    ws.addEventListener("close", (event) => {
      this.closeEvent = { code: event.code, reason: event.reason };
      this.notify();
    });
  }

  send(action: string, message?: unknown): void {
    this.ws.send(JSON.stringify({ action, message }));
  }

  sendText(text: string): void {
    this.ws.send(text);
  }

  /** Waits for the next message with this action that has not been taken yet. */
  async next(action: string, timeoutMs = 3000): Promise<any> {
    return this.waitFor(() => {
      const index = this.messages.findIndex((message) => message.action === action);
      if (index < 0) return undefined;
      return this.messages.splice(index, 1)[0]!.message;
    }, timeoutMs, `action "${action}"`);
  }

  async nextText(timeoutMs = 3000): Promise<string> {
    return this.waitFor(() => this.texts.shift(), timeoutMs, "a text frame");
  }

  async closed(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    return this.waitFor(() => this.closeEvent ?? undefined, timeoutMs, "close");
  }

  /** Waits for a "device" message that matches, skipping the ones before it. */
  async device(deviceId: string, state: string, timeoutMs = 3000): Promise<any> {
    return this.waitFor(() => {
      while (true) {
        const index = this.messages.findIndex((message) => message.action === "device" && message.message.deviceId === deviceId);
        if (index < 0) return undefined;
        const [found] = this.messages.splice(index, 1);
        if (found!.message.state === state) return found!.message;
      }
    }, timeoutMs, `device ${deviceId} ${state}`);
  }

  has(action: string): boolean {
    return this.messages.some((message) => message.action === action);
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
export function mockSfu(options: { missingTrack?: string } = {}): SfuCall[] {
  const calls: SfuCall[] = [];
  let sessions = 0;
  let mids = 100;
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

export const PUBLISH_TRACKS = [
  { mid: "0", trackName: "video_track" },
  { mid: "1", trackName: "audio_track" },
];
