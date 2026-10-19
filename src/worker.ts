import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

import {
  SOCKET_PATH,
  TOKEN_PATH,
  deviceTokenRequestSchema,
  idSchema,
  tokenRequestSchema,
  viewerTokenRequestSchema,
  type Grant,
  type TokenResponse,
} from "./shared/protocol";
import { accessSettings, verifyAccess } from "./server/access";
import { settings } from "./server/config";
import { REGISTRY_NAME } from "./server/registry";
import { CLAIMS_HEADER, upgradeRequired } from "./server/socket";
import { TokenError, roleForPublicKey, signToken, verifyToken } from "./server/token";

export { Device } from "./server/device";
export { Registry } from "./server/registry";
export { Room } from "./server/room";

const MAX_BODY_BYTES = 4096;

type App = { Bindings: Env };

const app = new Hono<App>();

app.use(TOKEN_PATH, (c, next) =>
  cors({
    origin: (origin) => allowedOrigin(c.env, origin),
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  })(c, next),
);

/**
 * Trades a public key for a 30 s, single-use access token. The IDs and rooms go in the body,
 * so the public key never appears in a URL.
 */
app.post(TOKEN_PATH, async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (c.env.TOKEN_LIMITER) {
    const { success } = await c.env.TOKEN_LIMITER.limit({ key: ip });
    if (!success) return error(c, 429, "rate_limited", "Too many token requests. Wait a minute and try again.");
  }

  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
  if (!bearer) return error(c, 401, "key_required", "Send Authorization: Bearer <public key>.");

  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return error(c, 413, "body_too_large", "The request body is too large.");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return error(c, 400, "body_invalid", "Send a JSON body.");
  }
  const parsed = tokenRequestSchema.safeParse(json);
  if (!parsed.success) return error(c, 400, "body_invalid", bodyProblem(json));
  const body = parsed.data;

  try {
    const role = await roleForPublicKey(c.env, bearer);
    if (!role) return error(c, 401, "key_invalid", "This public key is not valid for this worker.");
    if (body.can_subscribe !== (role === "viewer")) {
      return error(c, 401, "role_mismatch", `A ${role} key cannot be used with can_subscribe=${body.can_subscribe}.`);
    }

    const config = settings(c.env);
    let sub: string;
    let grant: Grant;
    if (body.can_subscribe) {
      sub = body.viewer_id;
      grant = {
        rooms: [body.room_id],
        canPublish: false,
        canSubscribe: true,
        ...(body.data_channels ? { dataChannels: true } : {}),
      };
    } else {
      const rooms = [...new Set(body.room_ids)];
      if (rooms.length > config.maxRoomsPerDevice) {
        return error(c, 400, "too_many_rooms", `A device can join up to ${config.maxRoomsPerDevice} rooms.`);
      }
      sub = body.device_id;
      grant = { rooms, canPublish: true, canSubscribe: false, ...(body.generation ? { generation: body.generation } : {}) };
    }

    const token = await signToken(c.env, role, sub, grant, config.tokenTtlSec);
    const url = new URL(c.req.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = SOCKET_PATH;
    url.search = "";
    const response: TokenResponse = { token, expires_in: config.tokenTtlSec, url: url.toString() };
    return c.json(response, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    if (err instanceof TokenError) return error(c, 503, err.code, err.message);
    throw err;
  }
});

/** Opens a device or viewer socket. The token decides which Durable Object gets it. */
app.get(SOCKET_PATH, async (c) => {
  if (upgradeRequired(c.req.raw)) return error(c, 426, "upgrade_required", "Open a WebSocket.");
  const token = c.req.query("access_token");
  if (!token) return error(c, 401, "token_required", "Add ?access_token=<token from POST /cloudflare/token>.");

  let verified;
  try {
    verified = await verifyToken(c.env, token);
  } catch (err) {
    if (err instanceof TokenError) {
      return error(c, err.code === "key_not_configured" ? 503 : 401, err.code, err.message);
    }
    throw err;
  }
  const { role, claims } = verified;

  const headers = new Headers(c.req.raw.headers);
  // Header values must be ASCII, and viewer IDs may hold any letters.
  headers.set(CLAIMS_HEADER, encodeURIComponent(JSON.stringify(claims)));
  const forwarded = new Request(c.req.raw.url, { headers });
  const stub =
    role === "device" ? c.env.DEVICES.getByName(claims.sub) : c.env.ROOMS.getByName(claims.grant.rooms[0]!);
  return stub.fetch(forwarded);
});

app.get("/cloudflare/health", (c) => c.json({ service: "cf-sfu-worker", ok: true }));

// Debug views of the Durable Objects for the demo pages. They show SFU session IDs, so they
// answer only on localhost, or when DEBUG_STATE is "true", and only with a public key.
app.get("/cloudflare/debug/rooms/:roomId", async (c) => {
  const denied = await debugDenied(c);
  if (denied) return denied;
  const roomId = idSchema.safeParse(c.req.param("roomId"));
  if (!roomId.success) return error(c, 400, "id_invalid", "The room ID is not valid.");
  return c.json(await roomDetails(c.env, roomId.data), 200, { "Cache-Control": "no-store" });
});

app.get("/cloudflare/debug/devices/:deviceId", async (c) => {
  const denied = await debugDenied(c);
  if (denied) return denied;
  const deviceId = idSchema.safeParse(c.req.param("deviceId"));
  if (!deviceId.success) return error(c, 400, "id_invalid", "The device ID is not valid.");
  const device = await c.env.DEVICES.getByName(deviceId.data).debugState();
  return c.json({ device }, 200, { "Cache-Control": "no-store" });
});

// The dashboard: every room this worker serves. See adminAuth for who may read it.
app.get("/cloudflare/admin/rooms", async (c) => {
  const admin = await adminAuth(c);
  if ("denied" in admin) return admin.denied;
  const rooms = await c.env.REGISTRY.getByName(REGISTRY_NAME).rooms();
  // A device can be in several rooms. Count it once, live if any room sees it live.
  const devices = new Map<string, boolean>();
  for (const room of rooms) {
    for (const device of room.devices) devices.set(device.deviceId, devices.get(device.deviceId) === true || device.state === "live");
  }
  const totals = {
    rooms: rooms.length,
    viewers: rooms.reduce((sum, room) => sum + room.viewers, 0),
    away: rooms.reduce((sum, room) => sum + room.away, 0),
    ipcViewers: rooms.reduce((sum, room) => sum + room.ipcViewers, 0),
    devices: devices.size,
    liveDevices: [...devices.values()].filter(Boolean).length,
  };
  const host = new URL(c.req.url).host;
  return c.json(
    { host, appId: c.env.REALTIME_SFU_APP_ID, auth: admin.auth, now: Date.now(), totals, rooms },
    200,
    { "Cache-Control": "no-store" },
  );
});

app.get("/cloudflare/admin/rooms/:roomId", async (c) => {
  const admin = await adminAuth(c);
  if ("denied" in admin) return admin.denied;
  const roomId = idSchema.safeParse(c.req.param("roomId"));
  if (!roomId.success) return error(c, 400, "id_invalid", "The room ID is not valid.");
  return c.json(await roomDetails(c.env, roomId.data), 200, { "Cache-Control": "no-store" });
});

// The demo pages and the dashboard live under /cloudflare/ too, so they deploy with the route.
app.get("/cloudflare/*", async (c) => {
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  return asset.status === 404 ? error(c, 404, "route_not_found", "Unknown path.") : asset;
});

app.all("/cloudflare/*", (c) => error(c, 404, "route_not_found", "Unknown path."));

// On workers.dev and localhost, the pages' old addresses.
app.get("/", (c) => c.redirect("/cloudflare/"));
app.get("/device", (c) => c.redirect("/cloudflare/device"));
app.get("/dashboard", (c) => c.redirect("/cloudflare/admin/"));

app.onError((err, c) => {
  console.error(JSON.stringify({ event: "unhandled_error", path: new URL(c.req.url).pathname, message: String(err) }));
  return error(c, 500, "internal_error", "Something went wrong.");
});

export default app;

function error(c: Context<App>, status: 400 | 401 | 403 | 404 | 413 | 426 | 429 | 500 | 503, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

async function debugDenied(c: Context<App>): Promise<Response | null> {
  const enabled = String(c.env.DEBUG_STATE) === "true" || LOOPBACK_HOSTS.has(new URL(c.req.url).hostname);
  if (!enabled) return error(c, 404, "route_not_found", "Unknown path.");
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
  let role: Awaited<ReturnType<typeof roleForPublicKey>> = null;
  try {
    role = bearer ? await roleForPublicKey(c.env, bearer) : null;
  } catch (err) {
    // A private key is missing, as for the token API.
    if (err instanceof TokenError) return error(c, 503, err.code, err.message);
    throw err;
  }
  if (!role) {
    return error(c, 401, "key_required", "Send Authorization: Bearer <device or viewer public key>.");
  }
  return null;
}

/** Which field of a token request is wrong, for the role the body asks for. */
function bodyProblem(json: unknown): string {
  const role = typeof json === "object" && json !== null ? (json as { can_subscribe?: unknown }).can_subscribe : undefined;
  const schema = role === true ? viewerTokenRequestSchema : role === false ? deviceTokenRequestSchema : null;
  const issue = schema?.safeParse(json).error?.issues[0];
  if (!issue) {
    return "Devices send {device_id, room_ids, can_subscribe: false}. Viewers send {viewer_id, room_id, can_subscribe: true}.";
  }
  return `${issue.path.join(".") || "body"}: ${issue.message}.`;
}

/** A room and its member devices, from their own Durable Objects. */
async function roomDetails(env: Env, roomId: string) {
  const room = await env.ROOMS.getByName(roomId).debugState();
  const devices = await Promise.all(room.members.map((member) => env.DEVICES.getByName(member.device_id).debugState()));
  return { room, devices };
}

type AdminAuth = { mode: "access"; email: string | null } | { mode: "key" } | { mode: "localhost" };

/**
 * Who may read /cloudflare/admin/*:
 * - With ACCESS_TEAM_DOMAIN and ACCESS_AUD, only requests Cloudflare Access let in. ADMIN_KEY no
 *   longer opens it, so there is no way around the sign-in.
 * - Otherwise, with ADMIN_KEY, whoever sends that key.
 * - Otherwise, only localhost.
 */
async function adminAuth(c: Context<App>): Promise<{ auth: AdminAuth } | { denied: Response }> {
  const access = accessSettings(c.env);
  if (access) {
    const identity = await verifyAccess(c.req.header("Cf-Access-Jwt-Assertion") ?? "", access);
    if (identity) return { auth: { mode: "access", email: identity.email } };
    return { denied: error(c, 403, "access_required", "Sign in with Cloudflare Access.") };
  }
  const key = String(c.env.ADMIN_KEY ?? "");
  if (!key) {
    if (LOOPBACK_HOSTS.has(new URL(c.req.url).hostname)) return { auth: { mode: "localhost" } };
    return { denied: error(c, 404, "route_not_found", "Unknown path.") };
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "")?.[1] ?? "";
  if (!(await sameSecret(bearer, key))) {
    return { denied: error(c, 401, "key_required", "Send Authorization: Bearer <ADMIN_KEY>.") };
  }
  return { auth: { mode: "key" } };
}

/** Compares in constant time, so the answer time says nothing about the key. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function allowedOrigin(env: Env, origin: string): string | null {
  const allowed = String(env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  // `*` is safe here: nothing authenticates with cookies.
  if (allowed.includes("*")) return "*";
  return allowed.includes(origin) ? origin : null;
}
