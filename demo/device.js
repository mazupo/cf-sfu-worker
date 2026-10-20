// Demo device: waits on the socket, publishes after "wake", stops after "sleep".
// This is what pi-webrtc does on a real device. With Enable IPC it also opens _lossy and
// _reliable, like pi-webrtc's --enable-ipc. With Play viewers' voices it plays the microphones
// of the viewers in its rooms, like pi-webrtc without --no-audio.
import {
  CLOSE_REPLACED,
  DeviceState,
  ErrorCode,
  backoff,
  createLog,
  decodeIpc,
  deviceProtocol as protocol,
  encodeIpc,
  openChannel,
  openSocket,
  persistForm,
  requestToken,
  stateName,
  viewerName,
} from "./common.js";
import { startDebugPanel } from "./debug.js";
import { clock } from "./time.js";

const form = document.getElementById("device-form");
const connectButton = document.getElementById("connect");
const disconnectButton = document.getElementById("disconnect");
const statusEl = document.getElementById("status");
const preview = document.getElementById("preview");
const ipcInput = document.getElementById("ipc");
const ipcPanel = document.getElementById("ipc-panel");
const ipcControl = document.getElementById("ipc-controller");
const ipcForm = document.getElementById("ipc-form");
const ipcLog = document.getElementById("ipc-log");
const voicesInput = document.getElementById("voices");
const voicesStatus = document.getElementById("voices-status");
const voicesAudio = document.getElementById("voices-audio");
const log = createLog(document.getElementById("log"));

document.getElementById("worker-url").value = location.origin;
persistForm(form, "cf-sfu-worker.device");

/** The one socket this tab uses. Events from any older socket are ignored. */
let socket = null;
let connectSeq = 0;
let reconnectTimer = null;
let pc = null;
let stream = null;
let iceServers = [];
/** Goes up with each start and stop, so a camera that opens late knows it is no longer wanted. */
let publication = 0;
/** The generation of the answer the PeerConnection uses, or 0 before the answer. */
let generation = 0;
/** Offers sent on this socket with no reply yet. Only the reply to the last offer counts. */
let unanswered = 0;
/** The PeerConnection sent its offer. Until then, any reply is for an older one. */
let offered = false;
let stopped = true;
let attempt = 0;
let stopPattern = null;
/** This connection publishes data channels, and plays the viewers' voices. Fixed until the next connect. */
let ipc = false;
let voices = true;
const channels = new Map(); // label -> RTCDataChannel
let controller = null; // { room, viewerId } of the viewer that can send to this device

function setStatus(text) {
  statusEl.textContent = text;
}

async function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  dropSocket();
  const seq = ++connectSeq;
  const data = new FormData(form);
  if (stopped) {
    ipc = ipcInput.checked;
    voices = voicesInput.checked;
  }
  stopped = false;
  connectButton.disabled = true;
  disconnectButton.disabled = false;
  ipcInput.disabled = true;
  voicesInput.disabled = true;
  ipcPanel.hidden = !ipc;
  const rooms = String(data.get("rooms")).split(",").map((room) => room.trim()).filter(Boolean);
  try {
    // While publishing, send the generation of our answer so a reconnect keeps the stream.
    const { token, url } = await requestToken(data.get("workerUrl"), data.get("deviceKey"), {
      device_id: data.get("deviceId"),
      room_ids: rooms,
      can_subscribe: false,
      ...(pc && generation ? { generation } : {}),
    });
    if (seq !== connectSeq || stopped) return; // a newer connect or a disconnect won
    const ws = openSocket(url, token);
    socket = ws;
    ws.addEventListener("message", (event) => {
      if (ws === socket) handle(protocol.parse(event.data));
    });
    ws.addEventListener("close", (event) => {
      if (ws === socket) onClose(event);
    });
  } catch (error) {
    if (seq !== connectSeq) return;
    log(`token: ${error.message}`);
    scheduleReconnect();
  }
}

function dropSocket() {
  const old = socket;
  socket = null;
  old?.close(1000, "closed by the page");
}

function disconnect() {
  stopped = true;
  connectSeq++;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  dropSocket();
  stopPublishing();
  controller = null;
  connectButton.disabled = false;
  disconnectButton.disabled = true;
  ipcInput.disabled = false;
  voicesInput.disabled = false;
  ipcPanel.hidden = true;
  setStatus("Disconnected.");
}

function onClose(event) {
  socket = null;
  log(`socket closed ${event.code} ${event.reason}`);
  if (stopped) return;
  if (event.code === CLOSE_REPLACED) {
    // Another connection uses this device ID. Do not reconnect, or the two would keep replacing each other.
    disconnect();
    setStatus("Another connection uses this device ID. Check the device ID. Not reconnecting.");
    return;
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delay = backoff(attempt++);
  setStatus(`Reconnecting in ${Math.round(delay / 1000)} s…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!stopped) connect();
  }, delay);
}

async function handle(frame) {
  if (!frame) return;
  const { action, message } = frame;
  log(`${action} ${JSON.stringify(message).slice(0, 160)}`);
  switch (action) {
    case "joined":
      attempt = 0;
      iceServers = message.iceServers;
      // Replies to offers on the old socket are lost.
      unanswered = 0;
      if (message.state === DeviceState.DEVICE_STATE_SLEEPING && pc) {
        // The worker started over, so the old publication is gone.
        stopPublishing();
      } else if (pc?.connectionState === "connected") {
        // `ready` may have been lost with the old socket.
        protocol.send(socket, "ready", {});
      }
      setStatus(`Connected as ${message.deviceId} in ${message.rooms.join(", ") || "no rooms"}. State: ${stateName(message.state)}.`);
      break;
    case "wake":
      await startPublishing();
      break;
    case "answer":
      unanswered = Math.max(0, unanswered - 1);
      if (pc && offered && unanswered === 0) {
        generation = message.generation;
        await pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
        setStatus(`Answer received (generation ${message.generation}). Connecting…`);
      }
      break;
    case "offer":
      // The viewers' voices changed: the SFU's offer for this PeerConnection.
      if (pc && generation) await answerVoices(message);
      break;
    case "sleep":
      stopPublishing();
      setStatus("Sleeping. Nobody is watching.");
      break;
    case "channels":
      if (pc && generation && unanswered === 0) openChannels(message.channels);
      break;
    case "control":
      controller = message.controller ?? null;
      ipcLine("note", "", controller ? `${viewerName(controller)} controls this device` : "Nobody controls this device");
      renderIpc();
      break;
    case "error":
      // Data channels that did not open leave the video running, and come after the answer.
      if (message.request === "offer" && message.code !== ErrorCode.ERROR_CODE_NO_DATA_CHANNELS) {
        unanswered = Math.max(0, unanswered - 1);
        if (!offered || unanswered > 0) break;
        if (message.code === ErrorCode.ERROR_CODE_WAKE_STALE) {
          // The worker wakes the device again if someone watches.
          stopPublishing();
          break;
        }
        // Publishing failed. Try again unless something else started or stopped meanwhile.
        const current = publication;
        setTimeout(() => {
          if (publication === current && socket) startPublishing();
        }, 3000);
      }
      break;
  }
}

/** Publishes from the start, with a new PeerConnection. */
async function startPublishing() {
  stopPublishing();
  const mine = publication;
  setStatus("Woken up. Starting the camera…");
  const media = await openMedia(new FormData(form).get("source"));
  if (publication !== mine) {
    for (const track of media.getTracks()) track.stop();
    return; // a sleep or another wake arrived while the camera was starting
  }
  stream = media;
  preview.srcObject = stream;
  const peer = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
  pc = peer;
  for (const track of stream.getTracks()) peer.addTransceiver(track, { direction: "sendonly" });
  // Any channel puts an m=application section in the offer. The worker sends the real ids.
  if (ipc) peer.createDataChannel("server-events", { negotiated: true, id: 0 });
  // A viewer's voice, pulled by the worker. One <audio> each, so they mix.
  peer.addEventListener("track", (event) => {
    if (peer !== pc || event.track.kind !== "audio") return;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.dataset.mid = event.transceiver.mid;
    audio.srcObject = new MediaStream([event.track]);
    voicesAudio.append(audio);
  });
  peer.addEventListener("connectionstatechange", () => {
    if (peer !== pc) return;
    log(`peer ${peer.connectionState}`);
    if (peer.connectionState === "connected") {
      // Media is flowing, so viewers can pull it now.
      protocol.send(socket, "ready", {});
      setStatus("Publishing.");
    }
    if (peer.connectionState === "failed") startPublishing();
  });
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  const tracks = peer.getTransceivers().map((transceiver) => ({
    mid: transceiver.mid,
    trackName: transceiver.sender.track?.kind === "audio" ? "audio_track" : "video_track",
  }));
  if (publication !== mine || socket?.readyState !== WebSocket.OPEN) return;
  unanswered += 1;
  offered = true;
  protocol.send(socket, "offer", { sdp: offer.sdp, tracks, dataChannels: ipc, voices });
}

/** Answers the SFU's offer, which lists every voice the PeerConnection now receives. */
async function answerVoices(message) {
  const peer = pc;
  await peer.setRemoteDescription({ type: "offer", sdp: message.sdp });
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  if (peer !== pc || socket?.readyState !== WebSocket.OPEN) return;
  protocol.send(socket, "answer", { sdp: answer.sdp });
  const mids = new Set(message.tracks.map((track) => track.mid));
  for (const audio of voicesAudio.querySelectorAll("audio")) {
    if (!mids.has(audio.dataset.mid)) audio.remove();
  }
  voicesStatus.hidden = false;
  voicesStatus.textContent = message.tracks.length > 0
    ? `Playing the voices of ${message.tracks.map((track) => viewerName({ room: track.room, viewerId: track.viewerId })).join(", ")}.`
    : "No viewer has a microphone.";
}

/** Opens _lossy and _reliable with the ids the worker sent. Both send and receive. */
function openChannels(list) {
  for (const spec of list) {
    const current = channels.get(spec.label);
    if (current?.id === spec.id && current.readyState !== "closed") continue;
    current?.close();
    const channel = openChannel(pc, spec);
    // Only the viewer in control can send here, so a message comes from the controller.
    channel.addEventListener("message", (event) =>
      ipcLine("in", spec.label, `${decodeIpc(event.data)}${controller ? `  (${viewerName(controller)})` : ""}`),
    );
    channel.addEventListener("open", renderIpc);
    channel.addEventListener("close", renderIpc);
    channels.set(spec.label, channel);
  }
  renderIpc();
}

function renderIpc() {
  ipcControl.textContent = controller ? `Controlled by ${viewerName(controller)}` : "Nobody controls this device.";
  const open = channels.get("_reliable")?.readyState === "open";
  for (const element of ipcForm.elements) element.disabled = !open;
}

function ipcLine(direction, label, text) {
  const item = document.createElement("li");
  item.className = direction;
  const arrow = direction === "out" ? "→" : direction === "in" ? "←" : "·";
  item.textContent = `${clock()} ${arrow} ${label ? `${label.slice(1)} ` : ""}${text}`;
  ipcLog.prepend(item);
  while (ipcLog.children.length > 100) ipcLog.lastElementChild.remove();
}

function stopPublishing() {
  publication += 1;
  generation = 0;
  offered = false;
  for (const channel of channels.values()) channel.close();
  channels.clear();
  renderIpc();
  pc?.close();
  pc = null;
  voicesAudio.replaceChildren();
  voicesStatus.hidden = true;
  stopPattern?.();
  stopPattern = null;
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
  preview.srcObject = null;
}

async function openMedia(source) {
  if (source === "camera") {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
    } catch (error) {
      log(`camera: ${error.message}. Using the test pattern.`);
    }
  }
  return testPattern();
}

/** A clock with hundredths of a second, so you can see that frames arrive and how late they are. */
function testPattern() {
  const canvas = Object.assign(document.createElement("canvas"), { width: 640, height: 360 });
  const context = canvas.getContext("2d");
  const name = new FormData(form).get("deviceId");
  const draw = () => {
    const now = new Date();
    context.fillStyle = `hsl(${(now.getSeconds() * 6) % 360} 45% 30%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#fff";
    context.font = "bold 48px ui-monospace, Consolas, monospace";
    context.fillText(patternClock(now), 40, 180);
    context.font = "24px system-ui, sans-serif";
    context.fillText(String(name), 40, 230);
  };
  draw();
  const timer = setInterval(draw, 10);
  stopPattern = () => clearInterval(timer);
  return canvas.captureStream(50);
}

/** 12:34:56.78 */
function patternClock(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const hundredths = pad(Math.floor(date.getMilliseconds() / 10));
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${hundredths}`;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  attempt = 0;
  connect();
});
disconnectButton.addEventListener("click", disconnect);
ipcForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const label = ipcForm.elements.label.value;
  const text = ipcForm.elements.text.value;
  const channel = channels.get(label);
  if (!text || channel?.readyState !== "open") return;
  // The SFU copies it to every viewer that opened this device's channels.
  channel.send(encodeIpc(text));
  ipcLine("out", label, text);
  ipcForm.elements.text.value = "";
});
renderIpc();

startDebugPanel({
  panel: document.getElementById("debug-panel"),
  body: document.getElementById("debug-body"),
  updated: document.getElementById("debug-updated"),
  url: () => {
    const data = new FormData(form);
    if (!data.get("workerUrl") || !data.get("deviceId") || !data.get("deviceKey")) return null;
    return new URL(`/cloudflare/debug/devices/${encodeURIComponent(data.get("deviceId"))}`, data.get("workerUrl")).toString();
  },
  key: () => new FormData(form).get("deviceKey"),
});
