// Demo viewer: joins one room, shows every device, and pulls each live device's tracks
// through a single PeerConnection. All signaling happens on one WebSocket.
import {
  CLOSE_REPLACED,
  backoff,
  createLog,
  openSocket,
  parseFrame,
  persistForm,
  requestToken,
  sendAction,
} from "./common.js";

/** Errors that will not change for the same publication. Do not ask again. */
const PERMANENT = new Set(["viewer_limit", "not_member", "track_not_found"]);

const form = document.getElementById("join-form");
const joinButton = document.getElementById("join");
const leaveButton = document.getElementById("leave");
const statusEl = document.getElementById("status");
const tilesEl = document.getElementById("tiles");
const log = createLog(document.getElementById("log"));

document.getElementById("worker-url").value = location.origin;
persistForm(form, "cf-sfu-worker.viewer");

/** The one socket this tab uses. Events from any older socket are ignored. */
let socket = null;
let connectSeq = 0;
let reconnectTimer = null;
let syncTimer = null;
let pc = null;
let iceServers = [];
let leaving = true;
let attempt = 0;
/** True from sending subscribe or unsubscribe until the server answers. */
let busy = false;
let busyFailures = 0;
const devices = new Map(); // deviceId -> DeviceInfo
const subscriptions = new Map(); // mid -> { deviceId, trackName, generation }
const refused = new Map(); // deviceId -> generation the server refused for good
const retries = new Map(); // deviceId -> { generation, count, at }
const tiles = new Map(); // deviceId -> { root, video, chip, note }

function viewerId() {
  // One ID per tab, so a reload resumes instead of joining again.
  try {
    let id = sessionStorage.getItem("cf-sfu-worker.viewerId");
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("cf-sfu-worker.viewerId", id);
    }
    return id;
  } catch {
    return (viewerId.fallback ??= crypto.randomUUID());
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

async function join() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  dropSocket();
  const seq = ++connectSeq;
  const data = new FormData(form);
  leaving = false;
  joinButton.disabled = true;
  leaveButton.disabled = false;
  setStatus("Requesting a token…");
  try {
    const { token, url } = await requestToken(data.get("workerUrl"), data.get("viewerKey"), {
      viewer_id: viewerId(),
      room_id: data.get("room"),
      can_subscribe: true,
    });
    if (seq !== connectSeq || leaving) return;
    const ws = openSocket(url, token);
    socket = ws;
    ws.addEventListener("message", (event) => {
      if (ws === socket) handle(parseFrame(event.data));
    });
    ws.addEventListener("close", (event) => {
      if (ws === socket) onClose(event);
    });
    setStatus("Connecting…");
  } catch (error) {
    if (seq !== connectSeq) return;
    log(`token: ${error.message}`);
    setStatus(error.message);
    scheduleReconnect();
  }
}

function dropSocket() {
  const old = socket;
  socket = null;
  old?.close(1000, "closed by the page");
}

function leave() {
  leaving = true;
  connectSeq++;
  clearTimeout(reconnectTimer);
  clearTimeout(syncTimer);
  reconnectTimer = null;
  sendAction(socket, "leave");
  dropSocket();
  resetPeer(false);
  devices.clear();
  refused.clear();
  retries.clear();
  renderTiles();
  joinButton.disabled = false;
  leaveButton.disabled = true;
  setStatus("Left the room.");
}

function onClose(event) {
  socket = null;
  busy = false;
  log(`socket closed ${event.code} ${event.reason}`);
  if (leaving) return;
  if (event.code === CLOSE_REPLACED) {
    leave();
    setStatus("Another tab joined with this viewer ID. This tab stopped.");
    return;
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (leaving || reconnectTimer) return;
  const delay = backoff(attempt++);
  setStatus(`Reconnecting in ${Math.round(delay / 1000)} s…`);
  // The same viewer_id within 30 s resumes the subscriptions on the server.
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!leaving) join();
  }, delay);
}

async function handle(frame) {
  if (!frame) return;
  const { action, message } = frame;
  switch (action) {
    case "joined":
      attempt = 0;
      iceServers = message.iceServers;
      if (!message.resumed || !pc) {
        resetPeer(true);
      } else {
        setSubscriptions(message.subscriptions);
      }
      devices.clear();
      for (const info of message.devices) devices.set(info.deviceId, info);
      busy = false;
      setStatus(`In room ${message.room} as ${message.viewerId}${message.resumed ? " (resumed)" : ""}.`);
      renderTiles();
      sync();
      break;
    case "device":
      devices.set(message.deviceId, message);
      renderTiles();
      sync();
      break;
    case "members": {
      const next = new Map(message.devices.map((info) => [info.deviceId, devices.get(info.deviceId) ?? info]));
      devices.clear();
      for (const [id, info] of next) devices.set(id, info);
      renderTiles();
      sync();
      break;
    }
    case "offer":
      await onOffer(message);
      break;
    case "subscribed":
      setSubscriptions(message.tracks);
      for (const sub of message.tracks) retries.delete(sub.deviceId);
      busy = false;
      busyFailures = 0;
      attachTracks();
      sync();
      break;
    case "error":
      onError(message);
      break;
  }
}

function onError(error) {
  log(`error ${error.code}${error.deviceId ? ` (${error.deviceId})` : ""}: ${error.message}`);
  if (error.deviceId) {
    // The server still finishes the request for the other devices.
    const generation = devices.get(error.deviceId)?.generation;
    if (PERMANENT.has(error.code)) {
      refused.set(error.deviceId, generation);
    } else {
      // Usually the device is still connecting. Ask again in a moment.
      const previous = retries.get(error.deviceId);
      const count = previous?.generation === generation ? previous.count + 1 : 0;
      retries.set(error.deviceId, { generation, count, at: Date.now() + Math.min(10_000, 1000 * 2 ** count) });
    }
    renderTiles();
    return;
  }
  if (["subscribe", "unsubscribe", "answer"].includes(error.action)) {
    busy = false;
    busyFailures++;
    scheduleSync(Math.min(10_000, 1000 * 2 ** busyFailures));
  }
}

async function onOffer(message) {
  if (message.sessionReset) resetPeer(true);
  setSubscriptions(message.tracks);
  await pc.setRemoteDescription({ type: "offer", sdp: message.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendAction(socket, "answer", { sdp: answer.sdp });
  attachTracks();
}

function scheduleSync(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

/** Brings the subscriptions in line with the devices that are live. One request at a time. */
function sync() {
  if (busy || socket?.readyState !== WebSocket.OPEN) return;

  // Tracks from a publication that ended: the device slept, restarted or left.
  const stale = [...subscriptions].filter(([, sub]) => {
    const info = devices.get(sub.deviceId);
    return !info || info.state !== "live" || info.generation !== sub.generation;
  });
  if (stale.length > 0) {
    busy = true;
    sendAction(socket, "unsubscribe", { mids: stale.map(([mid]) => mid) });
    return;
  }

  const now = Date.now();
  let nextRetry = Infinity;
  const wanted = [];
  for (const info of devices.values()) {
    if (info.state !== "live" || refused.get(info.deviceId) === info.generation) continue;
    const retry = retries.get(info.deviceId);
    if (retry?.generation === info.generation && retry.at > now) {
      nextRetry = Math.min(nextRetry, retry.at);
      continue;
    }
    for (const trackName of info.tracks) {
      const has = [...subscriptions.values()].some(
        (sub) => sub.deviceId === info.deviceId && sub.trackName === trackName && sub.generation === info.generation,
      );
      if (!has) wanted.push({ deviceId: info.deviceId, trackName });
    }
  }
  if (wanted.length > 0) {
    busy = true;
    sendAction(socket, "subscribe", { tracks: wanted });
  } else if (nextRetry !== Infinity) {
    scheduleSync(nextRetry - now);
  }
}

function setSubscriptions(list) {
  subscriptions.clear();
  for (const sub of list) subscriptions.set(sub.mid, sub);
}

function resetPeer(create) {
  pc?.close();
  pc = null;
  subscriptions.clear();
  for (const tile of tiles.values()) tile.video.srcObject = null;
  if (!create) return;
  const peer = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
  pc = peer;
  peer.addEventListener("track", attachTracks);
  peer.addEventListener("connectionstatechange", () => {
    if (peer === pc) log(`peer ${peer.connectionState}`);
  });
}

/** Puts each received track on the tile of the device it came from, matched by mid. */
function attachTracks() {
  if (!pc) return;
  const byDevice = new Map();
  for (const transceiver of pc.getTransceivers()) {
    const sub = transceiver.mid ? subscriptions.get(transceiver.mid) : undefined;
    const track = transceiver.receiver.track;
    if (!sub || !track) continue;
    if (!byDevice.has(sub.deviceId)) byDevice.set(sub.deviceId, []);
    byDevice.get(sub.deviceId).push(track);
  }
  for (const [deviceId, tile] of tiles) {
    const tracks = byDevice.get(deviceId) ?? [];
    const current = tile.video.srcObject?.getTracks() ?? [];
    const same = current.length === tracks.length && tracks.every((track) => current.includes(track));
    if (!same) tile.video.srcObject = tracks.length ? new MediaStream(tracks) : null;
  }
}

function renderTiles() {
  if (devices.size === 0) {
    tilesEl.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "empty",
        textContent: socket ? "No devices in this room yet." : "Join a room to see its devices.",
      }),
    );
    tiles.clear();
    return;
  }
  for (const id of [...tiles.keys()]) {
    if (!devices.has(id)) {
      tiles.get(id).root.remove();
      tiles.delete(id);
    }
  }
  tilesEl.querySelector(".empty")?.remove();
  for (const info of devices.values()) {
    let tile = tiles.get(info.deviceId);
    if (!tile) {
      const root = document.createElement("article");
      root.className = "tile";
      root.dataset.deviceId = info.deviceId;
      const video = Object.assign(document.createElement("video"), {
        autoplay: true,
        playsInline: true,
        muted: true,
        controls: true,
      });
      const bar = document.createElement("div");
      bar.className = "bar";
      const name = Object.assign(document.createElement("span"), { className: "name", textContent: info.deviceId });
      const chip = document.createElement("span");
      const note = document.createElement("span");
      note.className = "status";
      bar.append(name, note, chip);
      root.append(video, bar);
      tilesEl.append(root);
      tile = { root, video, chip, note };
      tiles.set(info.deviceId, tile);
    }
    tile.chip.className = `chip ${info.state}`;
    tile.chip.textContent = info.state;
    const refusedHere = refused.get(info.deviceId) === info.generation && info.state === "live";
    tile.note.textContent = refusedHere ? "refused" : info.lastError ?? "";
  }
  attachTracks();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  attempt = 0;
  join();
});
leaveButton.addEventListener("click", leave);
addEventListener("pagehide", () => sendAction(socket, "leave"));
