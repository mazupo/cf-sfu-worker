import { env, exports as workerExports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { signToken } from "../../src/server/token";
import {
  DEVICE_PUBLIC_KEY,
  ORIGIN,
  VIEWER_PUBLIC_KEY,
  connect,
  deviceToken,
  openSocket,
  requestToken,
  viewerToken,
} from "./helpers";

describe("POST /cloudflare/token", () => {
  test("a device key gets a short token and the socket URL", async () => {
    const response = await requestToken(DEVICE_PUBLIC_KEY, {
      device_id: "cam-1",
      room_ids: ["lab-a", "cam-1-only"],
      can_subscribe: false,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<{ token: string; expires_in: number; url: string }>();
    expect(body.expires_in).toBe(30);
    expect(body.url).toBe("ws://localhost/cloudflare/rtc");

    const [header, payload] = body.token.split(".").slice(0, 2).map((part) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))));
    expect(header).toEqual({ alg: "EdDSA", typ: "JWT", kid: "device" });
    expect(payload.sub).toBe("cam-1");
    expect(payload.exp - payload.iat).toBe(30);
    expect(payload.grant).toEqual({ rooms: ["lab-a", "cam-1-only"], canPublish: true, canSubscribe: false });
    // The public key never goes into the token.
    expect(body.token).not.toContain(DEVICE_PUBLIC_KEY);
    expect(JSON.stringify(payload)).not.toContain(DEVICE_PUBLIC_KEY);
  });

  test("requires a bearer key", async () => {
    const response = await workerExports.default.fetch(
      new Request(`${ORIGIN}/cloudflare/token`, { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "key_required" } });
  });

  test("rejects an unknown key", async () => {
    const response = await requestToken("not-a-key", { viewer_id: "v1", room_id: "lab-a", can_subscribe: true });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "key_invalid" } });
  });

  test("rejects a key used for the other role", async () => {
    const response = await requestToken(DEVICE_PUBLIC_KEY, { viewer_id: "v1", room_id: "lab-a", can_subscribe: true });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "role_mismatch" } });
  });

  test("rejects a bad body", async () => {
    const response = await requestToken(VIEWER_PUBLIC_KEY, { viewer_id: "bad id!", room_id: "lab-a", can_subscribe: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "body_invalid" } });
  });

  test("a viewer ID may have spaces and letters in any language", async () => {
    for (const viewerId of ["Richard Tai", "戴子桓", "Ana-María.2"]) {
      const response = await requestToken(VIEWER_PUBLIC_KEY, { viewer_id: viewerId, room_id: "lab-a", can_subscribe: true });
      expect(response.status, viewerId).toBe(200);
      const { token } = await response.json<{ token: string }>();
      const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
      expect(payload.sub).toBe(viewerId);
    }
    // The socket takes the token too.
    for (const viewerId of ["Richard Tai", "戴子桓"]) {
      const viewer = await connect(await viewerToken(viewerId, "lab-a"));
      viewer.close();
    }
  });

  test("says which field of the body is wrong", async () => {
    const cases: [string, unknown, string][] = [
      [VIEWER_PUBLIC_KEY, { viewer_id: " Richard", room_id: "lab-a", can_subscribe: true }, "viewer_id: use 1 to 64 letters, digits, spaces"],
      [VIEWER_PUBLIC_KEY, { viewer_id: "x".repeat(65), room_id: "lab-a", can_subscribe: true }, "viewer_id:"],
      [VIEWER_PUBLIC_KEY, { viewer_id: "v1", room_id: "lab a", can_subscribe: true }, 'room_id: use 1 to 64 letters, digits, ".", "_" or "-"'],
      [DEVICE_PUBLIC_KEY, { device_id: "Richard Tai", room_ids: ["lab-a"], can_subscribe: false }, "device_id:"],
      [DEVICE_PUBLIC_KEY, { device_id: "cam-1", room_ids: ["ok", "not ok"], can_subscribe: false }, "room_ids.1:"],
      [VIEWER_PUBLIC_KEY, { viewer: "v1" }, "Devices send {device_id"],
    ];
    for (const [key, body, message] of cases) {
      const response = await requestToken(key, body);
      expect(response.status).toBe(400);
      const json = await response.json<{ error: { code: string; message: string } }>();
      expect(json.error.code).toBe("body_invalid");
      expect(json.error.message, JSON.stringify(body)).toContain(message);
    }
  });

  test("limits how many rooms a device joins", async () => {
    const response = await requestToken(DEVICE_PUBLIC_KEY, {
      device_id: "cam-1",
      room_ids: ["r1", "r2", "r3", "r4", "r5"],
      can_subscribe: false,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "too_many_rooms" } });
  });

  test("answers CORS preflight", async () => {
    const response = await workerExports.default.fetch(
      new Request(`${ORIGIN}/cloudflare/token`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("GET /cloudflare/rtc", () => {
  test("needs a WebSocket upgrade", async () => {
    const token = await deviceToken("cam-1", ["lab-a"]);
    const response = await workerExports.default.fetch(new Request(`${ORIGIN}/cloudflare/rtc?access_token=${token}`));
    expect(response.status).toBe(426);
  });

  test("rejects a changed token", async () => {
    const token = await deviceToken("cam-1", ["lab-a"]);
    const [header, , signature] = token.split(".");
    const forged = btoa(JSON.stringify({ sub: "cam-2", jti: "x", iat: 1, exp: 4102444800, grant: { rooms: ["lab-a"], canPublish: true, canSubscribe: false } }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const response = await openSocket(`${header}.${forged}.${signature}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "token_invalid" } });
  });

  test("rejects an expired token", async () => {
    const token = await signToken(env, "device", "cam-1", { rooms: ["lab-a"], canPublish: true, canSubscribe: false }, -1);
    const response = await openSocket(token);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "token_expired" } });
  });

  test("a token works only once", async () => {
    const token = await deviceToken("cam-1", ["lab-a"]);
    const socket = await connect(token);
    await socket.next("joined");
    const again = await openSocket(token);
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: { code: "token_used" } });
    socket.close();
  });
});
