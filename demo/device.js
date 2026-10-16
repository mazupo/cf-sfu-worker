// Demo device: waits on the socket, publishes after "wake", stops after "sleep".
// This is what pi-webrtc does on a real device.
import {
  CLOSE_REPLACED,
  DeviceState,
  ErrorCode,
  backoff,
  createLog,
  deviceProtocol as protocol,
  openSocket,
  persistForm,
  requestToken,
  stateName,
} from "./common.js";
import { startDebugPanel } from "./debug.js";

const form = document.getElementById("device-form");
const connectButton = document.getElementById("connect");
const disconnectButton = document.getElementById("disconnect");
const statusEl = document.getElementById("status");
const preview = document.getElementById("preview");
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

function setStatus(text) {
  statusEl.textContent = text;
}

async function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  dropSocket();
  const seq = ++connectSeq;
  const data = new FormData(form);
  stopped = false;
  connectButton.disabled = true;
  disconnectButton.disabled = false;
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
  connectButton.disabled = false;
  disconnectButton.disabled = true;
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
    case "sleep":
      stopPublishing();
      setStatus("Sleeping. Nobody is watching.");
      break;
    case "error":
      if (message.request === "offer") {
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
  protocol.send(socket, "offer", { sdp: offer.sdp, tracks });
}

function stopPublishing() {
  publication += 1;
  generation = 0;
  offered = false;
  pc?.close();
  pc = null;
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
    context.fillText(clock(now), 40, 180);
    context.font = "24px system-ui, sans-serif";
    context.fillText(String(name), 40, 230);
  };
  draw();
  const timer = setInterval(draw, 10);
  stopPattern = () => clearInterval(timer);
  return canvas.captureStream(50);
}

/** 12:34:56.78 */
function clock(date) {
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
