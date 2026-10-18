// Shared helpers for the demo pages. Socket messages are protobuf (cloudflare.proto in
// mazupo/protocol); esbuild bundles the generated code into public/js. IPC messages on the data
// channels are pi-webrtc's protocol.Packet (packet.proto).
import {
  CloseCode,
  DeviceRequest,
  DeviceResponse,
  DeviceState,
  ErrorCode,
  ViewerRequest,
  ViewerResponse,
} from "../src/proto/cloudflare";
import { Packet } from "../src/proto/packet";
import { clock } from "./time.js";

export { DeviceState, ErrorCode };

/** The device's channels and the delivery settings every end must use (see cloudflare.proto). */
const CHANNEL_OPTIONS = {
  _lossy: { ordered: false, maxRetransmits: 0 },
  _reliable: { ordered: true },
};

/** Creates a channel the worker sent: negotiated, with its id and its label's settings. */
export function openChannel(pc, { label, id }) {
  const channel = pc.createDataChannel(label, { negotiated: true, id, ...CHANNEL_OPTIONS[label] });
  channel.binaryType = "arraybuffer";
  return channel;
}

/** Wraps text the way pi-webrtc expects an IPC message: Packet { raw }. */
export function encodeIpc(text) {
  return Packet.encode(Packet.fromPartial({ raw: new TextEncoder().encode(text) })).finish();
}

/** The text of an IPC message, or a note when it is something this page does not show. */
export function decodeIpc(data) {
  try {
    const packet = Packet.decode(new Uint8Array(data));
    const bytes = packet.raw ?? packet.ipc?.payload;
    if (bytes) return new TextDecoder().decode(bytes);
    return packet.stream ? "(part of a large message, not shown)" : "(not an IPC message)";
  } catch {
    return "(not a Packet)";
  }
}

export function sameViewer(a, b) {
  return Boolean(a && b && a.room === b.room && a.viewerId === b.viewerId);
}

/** "lab-a/3f2a9c1e…" */
export function viewerName(ref) {
  if (!ref) return "";
  const id = ref.viewerId.length > 12 ? `${ref.viewerId.slice(0, 8)}…` : ref.viewerId;
  return `${ref.room}/${id}`;
}

export const PING_INTERVAL_MS = 15_000;
export const CLOSE_REPLACED = CloseCode.CLOSE_CODE_REPLACED;

/** Trades a public key for a 30 s, single-use access token. */
export async function requestToken(workerUrl, publicKey, body) {
  const response = await fetch(new URL("/cloudflare/token", workerUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${publicKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error?.message ?? `Token request failed (${response.status}).`);
  return json;
}

/**
 * Calls onTick every intervalMs from a dedicated worker. When a tab is hidden for a few
 * minutes, browsers run its timers only once a minute, which is longer than the worker's
 * 45 s presence window. Timers in a dedicated worker keep their pace.
 */
function startTicker(intervalMs, onTick) {
  try {
    const source = `setInterval(() => postMessage(0), ${intervalMs});`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = onTick;
    return () => worker.terminate();
  } catch {
    const timer = setInterval(onTick, intervalMs);
    return () => clearInterval(timer);
  }
}

/** Opens the socket and sends "ping" every 15 s. The server answers "pong". */
export function openSocket(url, token) {
  const ws = new WebSocket(`${url}?access_token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";
  const stop = startTicker(PING_INTERVAL_MS, () => {
    if (ws.readyState === WebSocket.OPEN) ws.send("ping");
  });
  ws.addEventListener("close", stop);
  return ws;
}

/**
 * Sends requests and reads responses as `{action, message}`, where action is the field set in
 * the protobuf message, e.g. send(ws, "offer", {...}) sends DeviceRequest { offer: {...} }.
 */
function protocol(Request, Response) {
  return {
    send(ws, action, message = {}) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(Request.encode(Request.fromPartial({ [action]: message })).finish());
    },
    /** Returns null for "pong" and for frames it cannot read. */
    parse(data) {
      if (typeof data === "string") return null;
      try {
        const decoded = Response.decode(new Uint8Array(data));
        const [action, message] = Object.entries(decoded).find(([, value]) => value !== undefined) ?? [];
        return action ? { action, message } : null;
      } catch {
        return null;
      }
    },
  };
}

export const deviceProtocol = protocol(DeviceRequest, DeviceResponse);
export const viewerProtocol = protocol(ViewerRequest, ViewerResponse);

/** DEVICE_STATE_LIVE → "live" */
export function stateName(state) {
  return (DeviceState[state] ?? "unknown").replace("DEVICE_STATE_", "").toLowerCase();
}

/** ERROR_CODE_VIEWER_LIMIT → "viewer_limit" */
export function errorName(code) {
  return (ErrorCode[code] ?? "unknown").replace("ERROR_CODE_", "").toLowerCase();
}

/** Remembers form values in this browser. Storage can be blocked, so failures are ignored. */
export function persistForm(form, storageKey) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    for (const [name, value] of Object.entries(saved)) {
      const input = form.elements.namedItem(name);
      if (input?.type === "checkbox") input.checked = value === "on";
      else if (input && "value" in input && value) input.value = value;
    }
  } catch {
    // ignore
  }
  form.addEventListener("input", () => {
    try {
      const values = Object.fromEntries(new FormData(form));
      // An unchecked box is missing from the form data. Save it as off.
      for (const box of form.querySelectorAll("input[type=checkbox]")) values[box.name] = box.checked ? "on" : "";
      localStorage.setItem(storageKey, JSON.stringify(values));
    } catch {
      // ignore
    }
  });
}

export function createLog(element) {
  return (text) => {
    const time = clock();
    element.textContent = `${time}  ${text}\n${element.textContent}`.slice(0, 20_000);
  };
}

export function backoff(attempt) {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return base + Math.random() * 500;
}
