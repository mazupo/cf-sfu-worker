import { z } from "zod";

/** Paths. The Worker only runs for /cloudflare/*; everything else is a static demo page. */
export const TOKEN_PATH = "/cloudflare/token";
export const SOCKET_PATH = "/cloudflare/rtc";

/** Close codes sent by the Durable Objects. Clients must not reconnect after REPLACED. */
export const CLOSE_REPLACED = 4000;
export const CLOSE_HEARTBEAT_TIMEOUT = 4001;
export const CLOSE_LEFT = 1000;

/**
 * Device IDs and room IDs are locators, never credentials. They name Durable Objects and appear in
 * URLs, so they stay plain.
 */
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'use 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or digit');
/**
 * A viewer ID is also a name people read, e.g. who controls a device: letters and digits in any
 * language, spaces, ".", "_" and "-". It names nothing and is never part of a URL.
 */
export const viewerIdSchema = z
  .string()
  .regex(
    /^(?=.{1,64}$)[\p{L}\p{M}\p{N}._-](?:[\p{L}\p{M}\p{N} ._-]*[\p{L}\p{M}\p{N}._-])?$/u,
    'use 1 to 64 letters, digits, spaces, ".", "_" or "-", with no space at either end',
  );
export const trackNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const wakeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const sdpSchema = z.string().min(1).max(64_000);

// ---------------------------------------------------------------------------
// Token API
// ---------------------------------------------------------------------------

export const deviceTokenRequestSchema = z.object({
  device_id: idSchema,
  room_ids: z.array(idSchema).min(1),
  can_subscribe: z.literal(false),
  wake_id: wakeIdSchema.optional(),
});

export const viewerTokenRequestSchema = z.object({
  viewer_id: viewerIdSchema,
  room_id: idSchema,
  can_subscribe: z.literal(true),
});

export const tokenRequestSchema = z.union([deviceTokenRequestSchema, viewerTokenRequestSchema]);
export type TokenRequest = z.infer<typeof tokenRequestSchema>;

export type TokenResponse = {
  token: string;
  expires_in: number;
  url: string;
};

/** What a token allows. The structure follows LiveKit's video grant. */
export const grantSchema = z.object({
  rooms: z.array(idSchema).min(1),
  canPublish: z.boolean(),
  canSubscribe: z.boolean(),
  wakeId: wakeIdSchema.optional(),
});
export type Grant = z.infer<typeof grantSchema>;

export const claimsSchema = z.object({
  /** The device ID or the viewer ID. */
  sub: z.union([idSchema, viewerIdSchema]),
  jti: z.string().min(1).max(64),
  iat: z.number().int(),
  exp: z.number().int(),
  grant: grantSchema,
});
export type Claims = z.infer<typeof claimsSchema>;

export type Role = "device" | "viewer";

// ---------------------------------------------------------------------------
// Socket messages: {"action": "...", "message": {...}}. "ping" and "pong" are plain text.
// ---------------------------------------------------------------------------

export type DeviceState = "offline" | "sleeping" | "waking" | "live";

export type DeviceInfo = {
  deviceId: string;
  state: DeviceState;
  generation: number;
  tracks: string[];
  lastError: string | null;
};

export const offerMessageSchema = z.object({
  wakeId: wakeIdSchema,
  sdp: sdpSchema,
  tracks: z
    .array(z.object({ mid: z.string().min(1).max(32), trackName: trackNameSchema }))
    .min(1)
    .max(16),
});

export const unpublishedMessageSchema = z.object({ wakeId: wakeIdSchema });

export const subscribeMessageSchema = z.object({
  tracks: z
    .array(z.object({ deviceId: idSchema, trackName: trackNameSchema }))
    .min(1)
    .max(64),
});

export const answerMessageSchema = z.object({ sdp: sdpSchema });

export const unsubscribeMessageSchema = z.object({
  mids: z.array(z.string().min(1).max(32)).min(1).max(64),
});

export const incomingSchema = z.object({
  action: z.string().min(1).max(32),
  message: z.unknown().optional(),
});

export type Subscription = {
  deviceId: string;
  trackName: string;
  mid: string;
  generation: number;
};

/** Messages the Durable Objects send. */
export type OutgoingMessage =
  | { action: "joined"; message: DeviceJoined | ViewerJoined }
  | { action: "wake"; message: { wakeId: string } }
  | { action: "sleep"; message: { wakeId: string } }
  | { action: "answer"; message: { wakeId: string; generation: number; sdp: string } }
  | { action: "device"; message: DeviceInfo }
  | { action: "members"; message: { devices: DeviceInfo[] } }
  | { action: "offer"; message: { sdp: string; tracks: Subscription[]; sessionReset: boolean } }
  | { action: "subscribed"; message: { tracks: Subscription[] } }
  | { action: "error"; message: ErrorMessage };

export type DeviceJoined = {
  deviceId: string;
  state: DeviceState;
  generation: number;
  rooms: string[];
  iceServers: RTCIceServerLike[];
};

export type ViewerJoined = {
  viewerId: string;
  room: string;
  resumed: boolean;
  iceServers: RTCIceServerLike[];
  devices: DeviceInfo[];
  subscriptions: Subscription[];
};

export type ErrorMessage = {
  code: string;
  message: string;
  action?: string;
};

export type RTCIceServerLike = {
  urls: string | string[];
  username?: string;
  credential?: string;
};
