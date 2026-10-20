/** Numeric settings from Worker vars, with defaults for values that are missing or invalid. */
export type Settings = {
  tokenTtlSec: number;
  deviceStaleMs: number;
  wakeTimeoutMs: number;
  idleLingerMs: number;
  viewerStaleMs: number;
  viewerResumeMs: number;
  maxViewersPerDevice: number;
  maxDevicesPerRoom: number;
  maxRoomsPerDevice: number;
  maxMicrophonesPerRoom: number;
};

/** How often a watched device or a room with viewers checks heartbeats. */
export const PRESENCE_CHECK_MS = 60_000;
/**
 * How often a connected device nobody watches checks its socket. A deploy or restart drops the
 * socket without a close event, and nothing else wakes the device to leave its rooms.
 */
export const UNWATCHED_CHECK_MS = 5 * 60_000;
/** How long a room's interest in a device lasts, and how often the room renews it. */
export const WATCH_LEASE_MS = 10 * 60_000;
export const WATCH_RENEW_MS = 5 * 60_000;
/** A renewal leaves alone viewers counted this recently: their subscribe may still be running. */
export const COUNT_GRACE_MS = 60_000;
/** A device that dropped its socket shows as offline only after this grace period. */
export const DISCONNECT_GRACE_MS = 10_000;
/** A device that sends no ping for this long, and did not close its socket, leaves its rooms as if it had. */
export const DEVICE_GONE_MS = 60_000;
/** How many times a wake is sent before the device is marked as not responding. */
export const WAKE_ATTEMPTS = 2;
/** A viewer handed control of a device has this long to confirm with control_ready, from when it got canReply. */
export const CONTROL_CONFIRM_MS = 5_000;
/** How long the room may take to grant canReply at the SFU, before the confirm time starts. */
export const CONTROL_GRANT_MS = 10_000;
/** A device answers the SFU's offer for the viewers' voices within this, or plays none until it publishes again. */
export const VOICE_ANSWER_MS = 10_000;
/** A microphone the SFU could not pull yet, e.g. its first packets are still on their way, is tried again after this. */
export const VOICE_RETRY_MS = 2_000;
/** The track name of a viewer's microphone in its own SFU session. */
export const MICROPHONE_TRACK = "microphone";

export function settings(env: Env): Settings {
  const seconds = (value: unknown, fallback: number) => positive(value, fallback) * 1000;
  return {
    tokenTtlSec: positive(env.TOKEN_TTL_SECONDS, 30),
    deviceStaleMs: seconds(env.DEVICE_STALE_SECONDS, 45),
    wakeTimeoutMs: seconds(env.WAKE_TIMEOUT_SECONDS, 20),
    idleLingerMs: seconds(env.IDLE_LINGER_SECONDS, 30),
    viewerStaleMs: seconds(env.VIEWER_STALE_SECONDS, 45),
    viewerResumeMs: seconds(env.VIEWER_RESUME_SECONDS, 30),
    maxViewersPerDevice: positive(env.MAX_VIEWERS_PER_DEVICE, 10),
    maxDevicesPerRoom: positive(env.MAX_DEVICES_PER_ROOM, 16),
    maxRoomsPerDevice: positive(env.MAX_ROOMS_PER_DEVICE, 4),
    maxMicrophonesPerRoom: positive(env.MAX_MICROPHONES_PER_ROOM, 10),
  };
}

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
