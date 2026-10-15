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

/** Errors about one device. The server still finishes the subscribe for the other devices. */
const DEVICE_ERRORS = new Set(["not_member", "not_live", "viewer_limit", "track_not_found"]);

const form = document.getElementById("join-form");
const joinButton = document.getElementById("join");
const leaveButton = document.getElementById("leave");
const statusEl = document.getElementById("status");
const tilesEl = document.getElementById("tiles");
const log = createLog(document.getElementById("log"));

document.getElementById("worker-url").value = location.origin;
persistForm(form, "cf-sfu-worker.viewer");

let ws = null;
let pc = null;
let iceServers = [];
let leaving = true;
let attempt = 0;
/** True from sending subscribe or unsubscribe until the server says "subscribed". */
let busy = false;
const devices = new Map(); // deviceId -> DeviceInfo
const subscriptions = new Map(); // mid -> { deviceId, trackName, generation }
const refused = new Map(); // deviceId -> generation the server refused
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
    ws = openSocket(url, token);
    ws.addEventListener("message", (event) => handle(parseFrame(event.data)));
    ws.addEventListener("close", onClose);
    setStatus("Connecting…");
  } catch (error) {
    log(`token: ${error.message}`);
    setStatus(error.message);
    scheduleReconnect();
  }
}

function leave() {
  leaving = true;
  sendAction(ws, "leave");
  ws?.close(1000, "leave");
  ws = null;
  resetPeer(false);
  devices.clear();
  renderTiles();
  joinButton.disabled = false;
  leaveButton.disabled = true;
  setStatus("Left the room.");
}

function onClose(event) {
  ws = null;
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
  if (leaving) return;
  const delay = backoff(attempt++);
  setStatus(`Reconnecting in ${Math.round(delay / 1000)} s…`);
  // The same viewer_id within 30 s resumes the subscriptions on the server.
  setTimeout(() => {
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
      busy = false;
      attachTracks();
      sync();
      break;
    case "error":
      log(`error ${message.code}${message.deviceId ? ` (${message.deviceId})` : ""}: ${message.message}`);
      if (message.deviceId && DEVICE_ERRORS.has(message.code)) {
        refused.set(message.deviceId, devices.get(message.deviceId)?.generation);
        renderTiles();
      } else if (message.action === "subscribe" || message.action === "unsubscribe" || message.action === "answer") {
        busy = false;
        if (message.code === "busy") setTimeout(sync, 1000);
      }
      break;
  }
}

async function onOffer(message) {
  if (message.sessionReset) resetPeer(true);
  setSubscriptions(message.tracks);
  await pc.setRemoteDescription({ type: "offer", sdp: message.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendAction(ws, "answer", { sdp: answer.sdp });
  attachTracks();
}

/** Brings the subscriptions in line with the devices that are live. One request at a time. */
function sync() {
  if (busy || ws?.readyState !== WebSocket.OPEN) return;

  // Tracks from a publication that ended: the device slept, restarted or left.
  const stale = [...subscriptions].filter(([, sub]) => {
    const info = devices.get(sub.deviceId);
    return !info || info.state !== "live" || info.generation !== sub.generation;
  });
  if (stale.length > 0) {
    busy = true;
    sendAction(ws, "unsubscribe", { mids: stale.map(([mid]) => mid) });
    return;
  }

  const wanted = [];
  for (const info of devices.values()) {
    if (info.state !== "live" || refused.get(info.deviceId) === info.generation) continue;
    for (const trackName of info.tracks) {
      const has = [...subscriptions.values()].some(
        (sub) => sub.deviceId === info.deviceId && sub.trackName === trackName && sub.generation === info.generation,
      );
      if (!has) wanted.push({ deviceId: info.deviceId, trackName });
    }
  }
  if (wanted.length > 0) {
    busy = true;
    sendAction(ws, "subscribe", { tracks: wanted });
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
  pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
  pc.addEventListener("track", attachTracks);
  pc.addEventListener("connectionstatechange", () => log(`peer ${pc?.connectionState}`));
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
    tilesEl.replaceChildren(Object.assign(document.createElement("p"), {
      className: "empty",
      textContent: ws ? "No devices in this room yet." : "Join a room to see its devices.",
    }));
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
      const video = Object.assign(document.createElement("video"), { autoplay: true, playsInline: true, muted: true, controls: true });
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
    tile.note.textContent = refusedHere ? "viewer limit" : info.lastError ?? "";
  }
  attachTracks();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  attempt = 0;
  join();
});
leaveButton.addEventListener("click", leave);
addEventListener("pagehide", () => sendAction(ws, "leave"));
