import {
  DeviceRequest,
  DeviceResponse,
  SignalError,
  ViewerRequest,
  ViewerResponse,
  type ErrorCode,
  type MessageFns,
} from "../proto/cloudflare";

/** Largest frame accepted from a client. The SDP makes up most of it. */
const MAX_FRAME_BYTES = 128 * 1024;

export function sendDevice(ws: WebSocket, message: DeviceResponse): void {
  sendBytes(ws, DeviceResponse.encode(message).finish());
}

export function sendViewer(ws: WebSocket, message: ViewerResponse): void {
  sendBytes(ws, ViewerResponse.encode(message).finish());
}

function sendBytes(ws: WebSocket, bytes: Uint8Array): void {
  try {
    ws.send(bytes);
  } catch {
    // The socket is closing. Presence checks decide what happens next.
  }
}

/** A SignalError; the fields left out keep their defaults. */
export function signalError(fields: Partial<SignalError> & { code: ErrorCode; message: string }): SignalError {
  return SignalError.create(fields);
}

export function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

/** Decodes a binary frame, or returns null for text, oversized or broken frames. */
export function decodeFrame<T>(codec: MessageFns<T>, data: string | ArrayBuffer): T | null {
  if (typeof data === "string" || data.byteLength > MAX_FRAME_BYTES) return null;
  try {
    return codec.decode(new Uint8Array(data));
  } catch {
    return null;
  }
}

/** The oneof field that is set, e.g. "offer". Errors name the request they answer. */
export function requestName(request: DeviceRequest | ViewerRequest): string {
  return Object.entries(request).find(([, value]) => value !== undefined)?.[0] ?? "";
}

/** Runs tasks for one key one at a time, in arrival order. Lives only in memory. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.tails.set(key, next);
    const cleanup = () => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  }
}

export function upgradeRequired(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() !== "websocket";
}

/** The verified token claims travel from the Worker to the DO in this header. */
export const CLAIMS_HEADER = "x-cf-sfu-claims";
