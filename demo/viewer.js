// Demo viewer: joins one room, shows every device, and pulls each live device's tracks
// through a single PeerConnection. All signaling happens on one WebSocket. With Enable IPC it
// also opens each device's _lossy and _reliable, and can take control of a device to send to it.
import {
  CLOSE_REPLACED,
  DeviceState,
  ErrorCode,
  backoff,
  createLog,
  decodeIpc,
  encodeIpc,
  errorName,
  openChannel,
  openSocket,
  persistForm,
  requestToken,
  sameViewer,
  stateName,
  viewerName,
  viewerProtocol as protocol,
} from "./common.js";
import { startDebugPanel } from "./debug.js";

/** Errors that will not change for the same publication. Do not ask again. */
const PERMANENT = new Set([
  ErrorCode.ERROR_CODE_VIEWER_LIMIT,
  ErrorCode.ERROR_CODE_NOT_MEMBER,
  ErrorCode.ERROR_CODE_TRACK_NOT_FOUND,
  ErrorCode.ERROR_CODE_NO_DATA_CHANNELS,
]);
const LIVE = DeviceState.DEVICE_STATE_LIVE;

const form = document.getElementById("join-form");
const joinButton = document.getElementById("join");
const leaveButton = document.getElementById("leave");
const ipcInput = document.getElementById("ipc");
// It has no name, so persistForm does not share it between tabs. Each tab keeps its own.
const viewerIdInput = document.getElementById("viewer-id");
const statusEl = document.getElementById("status");
const tilesEl = document.getElementById("tiles");
const log = createLog(document.getElementById("log"));

document.getElementById("worker-url").value = location.origin;
persistForm(form, "cf-sfu-worker.viewer");
try {
  viewerIdInput.value = sessionStorage.getItem("cf-sfu-worker.viewerIdInput") ?? "";
} catch {
  // ignore
}
viewerIdInput.addEventListener("input", () => {
  try {
    sessionStorage.setItem("cf-sfu-worker.viewerIdInput", viewerIdInput.value);
  } catch {
    // ignore
  }
});

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
/** What the request in flight asks for, so per-device errors go to the right retry list. */
let pending = "tracks";
let busyFailures = 0;
/** This connection asked for data channels. Fixed until the next join. */
let ipc = false;
/** From sending our own offer until the answer. Subscribing before it gets busy. */
let transportPending = false;
/** A new PeerConnection after a session reset sends its own offer again. */
let offerDue = false;
/** Who this tab is in the room: { room, viewerId }. */
let me = null;
const devices = new Map(); // deviceId -> DeviceInfo
const subscriptions = new Map(); // mid -> { deviceId, trackName, generation }
const dataSubs = new Map(); // deviceId -> { generation, ids, canReply, channels: Map(label -> RTCDataChannel) }
const refused = new Map(); // deviceId -> generation the server refused for good
const retries = new Map(); // deviceId -> { generation, count, at }
const dataRetries = new Map(); // deviceId -> { generation, count, at }
const tiles = new Map(); // deviceId -> { root, video, chip, note, ipc }

function viewerId() {
  const typed = viewerIdInput.value.trim();
  if (typed) return typed;
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
  // A reconnect keeps what the first join chose.
  if (leaving) ipc = ipcInput.checked;
  leaving = false;
  joinButton.disabled = true;
  leaveButton.disabled = false;
  ipcInput.disabled = true;
  viewerIdInput.disabled = true;
  setStatus("Requesting a token…");
  try {
    const { token, url } = await requestToken(data.get("workerUrl"), data.get("viewerKey"), {
      viewer_id: viewerId(),
      room_id: data.get("room"),
      can_subscribe: true,
      ...(ipc ? { data_channels: true } : {}),
    });
    if (seq !== connectSeq || leaving) return;
    const ws = openSocket(url, token);
    socket = ws;
    ws.addEventListener("message", (event) => {
      if (ws === socket) handle(protocol.parse(event.data));
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
  protocol.send(socket, "leave");
  dropSocket();
  resetPeer(false);
  devices.clear();
  refused.clear();
  retries.clear();
  dataRetries.clear();
  renderTiles();
  joinButton.disabled = false;
  leaveButton.disabled = true;
  ipcInput.disabled = false;
  viewerIdInput.disabled = false;
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
      me = { room: message.room, viewerId: message.viewerId };
      if (!message.resumed || !pc) {
        resetPeer(true);
        connectEarly();
      } else {
        setSubscriptions(message.subscriptions);
        setData(message.data);
      }
      devices.clear();
      for (const info of message.devices) devices.set(info.deviceId, info);
      busy = false;
      setStatus(`In room ${message.room} as ${message.viewerId}${message.resumed ? " (resumed)" : ""}${ipc ? ", IPC on" : ""}.`);
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
      // A device that left counts its generations from 1 again when it comes back.
      for (const list of [refused, retries, dataRetries]) {
        for (const id of list.keys()) if (!devices.has(id)) list.delete(id);
      }
      renderTiles();
      sync();
      break;
    }
    case "offer":
      await onOffer(message);
      break;
    case "answer":
      await pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
      transportPending = false;
      sync();
      break;
    case "subscribed":
      setSubscriptions(message.tracks);
      setData(message.data);
      for (const sub of message.tracks) retries.delete(sub.deviceId);
      for (const sub of message.data) dataRetries.delete(sub.deviceId);
      busy = false;
      busyFailures = 0;
      attachTracks();
      if (offerDue) {
        offerDue = false;
        connectEarly();
      }
      sync();
      break;
    case "error":
      onError(message);
      break;
  }
}

function onError(error) {
  log(`error ${errorName(error.code)}${error.deviceId ? ` (${error.deviceId})` : ""}: ${error.message}`);
  if (error.deviceId && error.request === "subscribe") {
    // The server still finishes the request for the other devices.
    const generation = devices.get(error.deviceId)?.generation;
    const list = pending === "data" ? dataRetries : retries;
    if (PERMANENT.has(error.code) && pending !== "data") {
      refused.set(error.deviceId, generation);
    } else {
      // Usually the device is still connecting. Ask again in a moment.
      const previous = list.get(error.deviceId);
      const count = previous?.generation === generation ? previous.count + 1 : 0;
      const at = PERMANENT.has(error.code) ? Infinity : Date.now() + Math.min(10_000, 1000 * 2 ** count);
      list.set(error.deviceId, { generation, count, at });
    }
    renderTiles();
    return;
  }
  if (error.deviceId) {
    // take_control, release_control or control_ready
    ipcNote(error.deviceId, `${errorName(error.code)}: ${error.message}`);
    return;
  }
  if (["subscribe", "unsubscribe", "answer", "offer"].includes(error.request)) {
    busy = false;
    transportPending = false;
    busyFailures++;
    scheduleSync(Math.min(10_000, 1000 * 2 ** busyFailures));
  }
}

async function onOffer(message) {
  if (message.sessionReset) {
    resetPeer(true);
    offerDue = true;
  }
  setSubscriptions(message.tracks);
  await pc.setRemoteDescription({ type: "offer", sdp: message.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  protocol.send(socket, "answer", { sdp: answer.sdp });
  attachTracks();
}

/**
 * Connects the PeerConnection with our own offer, like pi-webrtc does: any channel puts an
 * m=application section in it. The SFU answers at once, so the PeerConnection connects while the
 * devices wake, and tracks come later with the SFU's offers. Data channels need it too.
 */
async function connectEarly() {
  transportPending = true;
  pc.createDataChannel("server-events", { negotiated: true, id: 0 });
  await pc.setLocalDescription(await pc.createOffer());
  protocol.send(socket, "offer", { sdp: pc.localDescription.sdp });
}

function scheduleSync(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

/** Brings the subscriptions in line with the devices that are live. One request at a time. */
function sync() {
  if (busy || transportPending || socket?.readyState !== WebSocket.OPEN) return;

  // Tracks from a publication that ended: the device slept, restarted or left.
  const stale = [...subscriptions].filter(([, sub]) => {
    const info = devices.get(sub.deviceId);
    return !info || info.state !== LIVE || info.generation !== sub.generation;
  });
  if (stale.length > 0) {
    send("tracks", "unsubscribe", { mids: stale.map(([mid]) => mid) });
    return;
  }

  const now = Date.now();
  let nextRetry = Infinity;
  const due = (list, info) => {
    const retry = list.get(info.deviceId);
    if (retry?.generation !== info.generation || retry.at <= now) return true;
    nextRetry = Math.min(nextRetry, retry.at);
    return false;
  };

  const wanted = [];
  for (const info of devices.values()) {
    if (info.state !== LIVE || refused.get(info.deviceId) === info.generation || !due(retries, info)) continue;
    for (const trackName of info.tracks) {
      const has = [...subscriptions.values()].some(
        (sub) => sub.deviceId === info.deviceId && sub.trackName === trackName && sub.generation === info.generation,
      );
      if (!has) wanted.push({ deviceId: info.deviceId, trackName });
    }
  }
  if (wanted.length > 0) {
    send("tracks", "subscribe", { tracks: wanted });
    return;
  }

  // Data channels come after the media, so they never hold up the first picture. A device that
  // published again gets new channels; subscribing again keeps its control.
  if (ipc) {
    const wantedData = [];
    for (const info of devices.values()) {
      if (info.state !== LIVE || !info.dataChannels || !due(dataRetries, info)) continue;
      const current = dataSubs.get(info.deviceId);
      if (current?.generation === info.generation) continue;
      // Close the old channels now, so their ids are free when the new ones arrive.
      if (current) closeChannels(info.deviceId);
      wantedData.push(info.deviceId);
    }
    if (wantedData.length > 0) {
      send("data", "subscribe", { data: wantedData });
      return;
    }
  }
  if (nextRetry !== Infinity) scheduleSync(nextRetry - now);
}

function send(kind, action, message) {
  busy = true;
  pending = kind;
  protocol.send(socket, action, message);
}

function setSubscriptions(list) {
  subscriptions.clear();
  for (const sub of list) subscriptions.set(sub.mid, sub);
}

/** Opens the channels the server lists and closes the others. */
function setData(list) {
  const listed = new Set();
  for (const entry of list) {
    listed.add(entry.deviceId);
    const ids = entry.channels.map((channel) => `${channel.label}:${channel.id}`).join(",");
    let current = dataSubs.get(entry.deviceId);
    if (current && (current.ids !== ids || current.generation !== entry.generation)) {
      closeChannels(entry.deviceId);
      current = undefined;
    }
    if (!current) {
      if (!pc) continue;
      current = { generation: entry.generation, ids, canReply: false, channels: new Map() };
      for (const spec of entry.channels) {
        const channel = openChannel(pc, spec);
        channel.addEventListener("message", (event) => ipcLine(entry.deviceId, "in", spec.label, decodeIpc(event.data)));
        channel.addEventListener("open", renderTiles);
        channel.addEventListener("close", renderTiles);
        current.channels.set(spec.label, channel);
      }
      dataSubs.set(entry.deviceId, current);
    }
    const granted = entry.canReply && !current.canReply;
    current.canReply = entry.canReply;
    if (granted) confirmControl(entry.deviceId, current);
  }
  for (const deviceId of [...dataSubs.keys()]) {
    if (!listed.has(deviceId)) closeChannels(deviceId);
  }
  renderTiles();
}

function closeChannels(deviceId) {
  const current = dataSubs.get(deviceId);
  dataSubs.delete(deviceId);
  for (const channel of current?.channels.values() ?? []) channel.close();
}

/** Tells the server the takeover is done once the channels can carry our messages. */
async function confirmControl(deviceId, current) {
  const reliable = current.channels.get("_reliable");
  if (reliable && reliable.readyState !== "open") {
    await new Promise((resolve) => reliable.addEventListener("open", resolve, { once: true }));
  }
  if (dataSubs.get(deviceId) === current && current.canReply) protocol.send(socket, "controlReady", { deviceId });
}

function resetPeer(create) {
  for (const deviceId of [...dataSubs.keys()]) closeChannels(deviceId);
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
      closeChannels(id);
    }
  }
  tilesEl.querySelector(".empty")?.remove();
  for (const info of devices.values()) {
    let tile = tiles.get(info.deviceId);
    if (!tile) {
      tile = createTile(info.deviceId);
      tiles.set(info.deviceId, tile);
    }
    tile.chip.className = `chip ${stateName(info.state)}`;
    tile.chip.textContent = stateName(info.state);
    const refusedHere = refused.get(info.deviceId) === info.generation && info.state === LIVE;
    tile.note.textContent = refusedHere ? "refused" : info.lastError ? errorName(info.lastError) : "";
    renderControl(tile, info);
  }
  attachTracks();
}

function createTile(deviceId) {
  const root = document.createElement("article");
  root.className = "tile";
  root.dataset.deviceId = deviceId;
  const video = Object.assign(document.createElement("video"), {
    autoplay: true,
    playsInline: true,
    muted: true,
    controls: true,
  });
  const bar = document.createElement("div");
  bar.className = "bar";
  const name = Object.assign(document.createElement("span"), { className: "name", textContent: deviceId });
  const chip = document.createElement("span");
  const note = document.createElement("span");
  note.className = "status";
  bar.append(name, note, chip);
  root.append(video, bar, createIpcBox(deviceId));
  tilesEl.append(root);
  const box = root.querySelector(".ipc");
  return {
    root,
    video,
    chip,
    note,
    ipc: {
      box,
      control: box.querySelector(".control"),
      take: box.querySelector("[data-action=take]"),
      release: box.querySelector("[data-action=release]"),
      log: box.querySelector(".ipc-log"),
      send: box.querySelector(".ipc-send"),
    },
  };
}

/** The tile's IPC window: who controls the device, its messages, and a send box. */
function createIpcBox(deviceId) {
  const box = document.createElement("section");
  box.className = "ipc";
  box.innerHTML = `
    <div class="ipc-head">
      <span class="control"></span>
      <button type="button" class="secondary small" data-action="take">Take control</button>
      <button type="button" class="secondary small" data-action="release">Release control</button>
    </div>
    <ol class="ipc-log" aria-live="polite"></ol>
    <form class="ipc-send">
      <select name="label" aria-label="Channel">
        <option value="_reliable">reliable</option>
        <option value="_lossy">lossy</option>
      </select>
      <input name="text" autocomplete="off" aria-label="Message">
      <button type="submit" class="small">Send</button>
    </form>`;
  box.querySelector(".ipc-send input").placeholder = `Message to ${deviceId}`;
  box.querySelector("[data-action=take]").addEventListener("click", () => protocol.send(socket, "takeControl", { deviceId }));
  box.querySelector("[data-action=release]").addEventListener("click", () =>
    protocol.send(socket, "releaseControl", { deviceId }),
  );
  box.querySelector(".ipc-send").addEventListener("submit", (event) => {
    event.preventDefault();
    const sendForm = event.currentTarget;
    const label = sendForm.elements.label.value;
    const text = sendForm.elements.text.value;
    const channel = dataSubs.get(deviceId)?.channels.get(label);
    if (!text || channel?.readyState !== "open") return;
    channel.send(encodeIpc(text));
    ipcLine(deviceId, "out", label, text);
    sendForm.elements.text.value = "";
  });
  return box;
}

function renderControl(tile, info) {
  const { box, control, take, release, send } = tile.ipc;
  const current = dataSubs.get(info.deviceId);
  // Spectators see who controls the device too; only IPC viewers get the window and the buttons.
  box.hidden = !info.dataChannels && !info.controller && !current;
  const mine = sameViewer(info.controller, me);
  const takingOver = sameViewer(info.handover, me);
  const inLine = info.waiting.some((ref) => sameViewer(ref, me));
  let text = mine
    ? "You control this device"
    : takingOver
      ? "Taking over…"
      : info.controller
        ? `Controlled by ${viewerName(info.controller)}`
        : info.handover
          ? `Handing over to ${viewerName(info.handover)}`
          : "Nobody controls this device";
  if (info.waiting.length > 0) text += ` · waiting: ${info.waiting.map(viewerName).join(", ")}`;
  control.textContent = text;
  control.classList.toggle("mine", mine);

  take.hidden = !ipc || !current || mine || takingOver || inLine;
  take.textContent = info.controller || info.handover ? "Wait in line" : "Take control";
  release.hidden = !ipc || !(mine || takingOver || inLine);
  release.textContent = inLine ? "Leave the line" : "Release control";
  tile.ipc.log.hidden = !ipc;
  send.hidden = !ipc;
  const open = current?.channels.get("_reliable")?.readyState === "open";
  for (const element of send.elements) element.disabled = !(mine && current?.canReply && open);
}

function ipcLine(deviceId, direction, label, text) {
  const list = tiles.get(deviceId)?.ipc.log;
  if (!list) return;
  const item = document.createElement("li");
  item.className = direction;
  const time = new Date().toLocaleTimeString();
  const arrow = direction === "out" ? "→" : direction === "in" ? "←" : "·";
  item.textContent = `${time} ${arrow} ${label ? `${label.slice(1)} ` : ""}${text}`;
  list.prepend(item);
  while (list.children.length > 50) list.lastElementChild.remove();
}

function ipcNote(deviceId, text) {
  ipcLine(deviceId, "note", "", text);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  attempt = 0;
  join();
});
leaveButton.addEventListener("click", leave);

startDebugPanel({
  panel: document.getElementById("debug-panel"),
  body: document.getElementById("debug-body"),
  updated: document.getElementById("debug-updated"),
  url: () => {
    const data = new FormData(form);
    if (!data.get("workerUrl") || !data.get("room") || !data.get("viewerKey")) return null;
    return new URL(`/cloudflare/debug/rooms/${encodeURIComponent(data.get("room"))}`, data.get("workerUrl")).toString();
  },
  key: () => new FormData(form).get("viewerKey"),
});
