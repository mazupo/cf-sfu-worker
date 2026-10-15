// Shared helpers for the demo pages. Plain browser APIs only.

export const PING_INTERVAL_MS = 15_000;
export const CLOSE_REPLACED = 4000;

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

/** Opens the socket and sends "ping" every 15 s. The server answers "pong". */
export function openSocket(url, token) {
  const ws = new WebSocket(`${url}?access_token=${encodeURIComponent(token)}`);
  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send("ping");
  }, PING_INTERVAL_MS);
  ws.addEventListener("close", () => clearInterval(timer));
  return ws;
}

export function sendAction(ws, action, message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action, message }));
}

/** Parses a frame. Returns null for "pong". */
export function parseFrame(data) {
  if (data === "pong") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Remembers form values in this browser. Storage can be blocked, so failures are ignored. */
export function persistForm(form, storageKey) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    for (const [name, value] of Object.entries(saved)) {
      const input = form.elements.namedItem(name);
      if (input && "value" in input && value) input.value = value;
    }
  } catch {
    // ignore
  }
  form.addEventListener("input", () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(new FormData(form))));
    } catch {
      // ignore
    }
  });
}

export function createLog(element) {
  return (text) => {
    const time = new Date().toLocaleTimeString();
    element.textContent = `${time}  ${text}\n${element.textContent}`.slice(0, 20_000);
  };
}

export function backoff(attempt) {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return base + Math.random() * 500;
}
