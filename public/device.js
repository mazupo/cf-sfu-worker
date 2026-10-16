// Demo device: waits on the socket, publishes after "wake", stops after "sleep".
// This is what pi-webrtc does on a real device.
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
let wakeId = null;
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
    // While publishing, send the current wake_id so a reconnect keeps the stream.
    const { token, url } = await requestToken(data.get("workerUrl"), data.get("deviceKey"), {
      device_id: data.get("deviceId"),
      room_ids: rooms,
      can_subscribe: false,
      ...(pc && wakeId ? { wake_id: wakeId } : {}),
    });
    if (seq !== connectSeq || stopped) return; // a newer connect or a disconnect won
    const ws = openSocket(url, token);
    socket = ws;
    ws.addEventListener("message", (event) => {
      if (ws === socket) handle(parseFrame(event.data));
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
  wakeId = null;
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
      if (message.state === "sleeping" && pc) {
        // The worker started over, so the old publication is gone.
        stopPublishing();
        wakeId = null;
      } else if (pc?.connectionState === "connected") {
        sendAction(socket, "ready", { wakeId });
      }
      setStatus(`Connected as ${message.deviceId} in ${message.rooms.join(", ") || "no rooms"}. State: ${message.state}.`);
      break;
    case "wake":
      if (pc && wakeId === message.wakeId) {
        // A repeated wake. Confirm again if connected, otherwise let the current attempt finish.
        if (pc.connectionState === "connected") sendAction(socket, "ready", { wakeId });
        else if (pc.connectionState === "failed") await startPublishing(message.wakeId);
        return;
      }
      await startPublishing(message.wakeId);
      break;
    case "answer":
      if (pc && message.wakeId === wakeId) {
        await pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
        setStatus(`Answer received (generation ${message.generation}). Connecting…`);
      }
      break;
    case "sleep":
      if (message.wakeId === wakeId) {
        stopPublishing();
        sendAction(socket, "unpublished", { wakeId: message.wakeId });
        wakeId = null;
        setStatus("Sleeping. Nobody is watching.");
      }
      break;
    case "error":
      if (message.action === "offer" && wakeId) {
        // Publishing failed. Try again while the wake is still current.
        const current = wakeId;
        setTimeout(() => {
          if (wakeId === current && socket) startPublishing(current);
        }, 3000);
      }
      break;
  }
}

async function startPublishing(id) {
  stopPublishing();
  wakeId = id;
  setStatus("Woken up. Starting the camera…");
  const media = await openMedia(new FormData(form).get("source"));
  if (wakeId !== id) {
    for (const track of media.getTracks()) track.stop();
    return; // a sleep arrived while the camera was starting
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
      sendAction(socket, "ready", { wakeId: id });
      setStatus("Publishing.");
    }
    if (peer.connectionState === "failed" && wakeId === id) startPublishing(id);
  });
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  const tracks = peer.getTransceivers().map((transceiver) => ({
    mid: transceiver.mid,
    trackName: transceiver.sender.track?.kind === "audio" ? "audio_track" : "video_track",
  }));
  sendAction(socket, "offer", { wakeId: id, sdp: offer.sdp, tracks });
}

function stopPublishing() {
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
