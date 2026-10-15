import type { ErrorMessage, OutgoingMessage } from "../shared/protocol";
import { incomingSchema } from "../shared/protocol";

export function send(ws: WebSocket, message: OutgoingMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The socket is closing. Presence checks decide what happens next.
  }
}

export function sendError(ws: WebSocket, error: ErrorMessage): void {
  send(ws, { action: "error", message: error });
}

export function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

export type Incoming = { action: string; message: unknown };

export function parseIncoming(data: string | ArrayBuffer): Incoming | null {
  if (typeof data !== "string" || data.length > 128 * 1024) return null;
  try {
    const parsed = incomingSchema.safeParse(JSON.parse(data));
    return parsed.success ? { action: parsed.data.action, message: parsed.data.message } : null;
  } catch {
    return null;
  }
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
