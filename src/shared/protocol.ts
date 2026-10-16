import { z } from "zod";

import { DeviceState, ErrorCode, type DeviceInfo } from "../proto/cloudflare";

/** Paths. The Worker only runs for /cloudflare/*; everything else is a static demo page. */
export const TOKEN_PATH = "/cloudflare/token";
export const SOCKET_PATH = "/cloudflare/rtc";

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
/** The generation of the device's last answer. Sent again on a reconnect, it keeps the stream. */
const generationSchema = z.number().int().min(1);

const sdpSchema = z.string().min(1).max(64_000);
const midSchema = z.string().min(1).max(32);

// ---------------------------------------------------------------------------
// Token API (JSON over HTTP)
// ---------------------------------------------------------------------------

export const deviceTokenRequestSchema = z.object({
  device_id: idSchema,
  room_ids: z.array(idSchema).min(1),
  can_subscribe: z.literal(false),
  generation: generationSchema.optional(),
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
  generation: generationSchema.optional(),
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
// Socket messages. The types come from cloudflare.proto in mazupo/protocol; these schemas add
// the rules protobuf cannot express, and run on the decoded messages.
// ---------------------------------------------------------------------------

export const publishOfferSchema = z.object({
  sdp: sdpSchema,
  tracks: z.array(z.object({ mid: midSchema, trackName: trackNameSchema })).min(1).max(16),
});

export const subscribeSchema = z.object({
  tracks: z.array(z.object({ deviceId: idSchema, trackName: trackNameSchema })).min(1).max(64),
});

export const subscribeAnswerSchema = z.object({ sdp: sdpSchema });

export const unsubscribeSchema = z.object({ mids: z.array(midSchema).min(1).max(64) });

/** DEVICE_STATE_LIVE → "live", for logs and the debug view. */
export function stateName(state: DeviceState): string {
  return (DeviceState[state] ?? "unknown").replace("DEVICE_STATE_", "").toLowerCase();
}

/** ERROR_CODE_WAKE_TIMEOUT → "wake_timeout", for logs and the debug view. */
export function errorName(code: ErrorCode): string {
  return (ErrorCode[code] ?? "unknown").replace("ERROR_CODE_", "").toLowerCase();
}

/** DeviceInfo with names instead of numbers, for the debug view. */
export function debugInfo(info: DeviceInfo) {
  return { ...info, state: stateName(info.state), lastError: info.lastError ? errorName(info.lastError) : null };
}
