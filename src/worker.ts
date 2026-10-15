import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

import {
  SOCKET_PATH,
  TOKEN_PATH,
  deviceTokenRequestSchema,
  tokenRequestSchema,
  viewerTokenRequestSchema,
  type Grant,
  type TokenResponse,
} from "./shared/protocol";
import { settings } from "./server/config";
import { CLAIMS_HEADER, upgradeRequired } from "./server/socket";
import { TokenError, roleForPublicKey, signToken, verifyToken } from "./server/token";

export { Device } from "./server/device";
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
      grant = { rooms: [body.room_id], canPublish: false, canSubscribe: true };
    } else {
      const rooms = [...new Set(body.room_ids)];
      if (rooms.length > config.maxRoomsPerDevice) {
        return error(c, 400, "too_many_rooms", `A device can join up to ${config.maxRoomsPerDevice} rooms.`);
      }
      sub = body.device_id;
      grant = { rooms, canPublish: true, canSubscribe: false, ...(body.wake_id ? { wakeId: body.wake_id } : {}) };
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

app.all("/cloudflare/*", (c) => error(c, 404, "route_not_found", "Unknown path."));

app.onError((err, c) => {
  console.error(JSON.stringify({ event: "unhandled_error", path: new URL(c.req.url).pathname, message: String(err) }));
  return error(c, 500, "internal_error", "Something went wrong.");
});

export default app;

function error(c: Context<App>, status: 400 | 401 | 404 | 413 | 426 | 429 | 500 | 503, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
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

function allowedOrigin(env: Env, origin: string): string | null {
  const allowed = String(env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  // `*` is safe here: nothing authenticates with cookies.
  if (allowed.includes("*")) return "*";
  return allowed.includes(origin) ? origin : null;
}
