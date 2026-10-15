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

const form = document.getElementById("device-form");
const connectButton = document.getElementById("connect");
const disconnectButton = document.getElementById("disconnect");
const statusEl = document.getElementById("status");
const preview = document.getElementById("preview");
const log = createLog(document.getElementById("log"));

document.getElementById("worker-url").value = location.origin;
persistForm(form, "cf-sfu-worker.device");

let ws = null;
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
    ws = openSocket(url, token);
    ws.addEventListener("message", (event) => handle(parseFrame(event.data)));
    ws.addEventListener("close", onClose);
  } catch (error) {
    log(`token: ${error.message}`);
    scheduleReconnect();
  }
}

function disconnect() {
  stopped = true;
  ws?.close(1000, "disconnect");
  ws = null;
  stopPublishing();
  connectButton.disabled = false;
  disconnectButton.disabled = true;
  setStatus("Disconnected.");
}

function onClose(event) {
  ws = null;
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
  if (stopped) return;
  const delay = backoff(attempt++);
  setStatus(`Reconnecting in ${Math.round(delay / 1000)} s…`);
  setTimeout(() => {
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
      // The worker started a new publication, so drop the old one.
      if (message.state === "sleeping" && pc) stopPublishing();
      setStatus(`Connected as ${message.deviceId} in ${message.rooms.join(", ") || "no rooms"}. State: ${message.state}.`);
      break;
    case "wake":
      if (pc && wakeId === message.wakeId) return; // already publishing for this wake
      await startPublishing(message.wakeId);
      break;
    case "answer":
      if (pc && message.wakeId === wakeId) {
        await pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
        setStatus(`Publishing (generation ${message.generation}).`);
      }
      break;
    case "sleep":
      if (message.wakeId === wakeId) {
        stopPublishing();
        sendAction(ws, "unpublished", { wakeId: message.wakeId });
        wakeId = null;
        setStatus("Sleeping. Nobody is watching.");
      }
      break;
    case "error":
      if (message.action === "offer" && wakeId) {
        // Publishing failed. Try again while the wake is still current.
        const current = wakeId;
        setTimeout(() => {
          if (wakeId === current && ws) startPublishing(current);
        }, 3000);
      }
      break;
  }
}

async function startPublishing(id) {
  stopPublishing();
  wakeId = id;
  setStatus("Woken up. Starting the camera…");
  stream = await openMedia(new FormData(form).get("source"));
  preview.srcObject = stream;
  pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
  for (const track of stream.getTracks()) pc.addTransceiver(track, { direction: "sendonly" });
  pc.addEventListener("connectionstatechange", () => {
    log(`peer ${pc?.connectionState}`);
    if (pc?.connectionState === "failed" && wakeId === id) startPublishing(id);
  });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const tracks = pc.getTransceivers().map((transceiver) => ({
    mid: transceiver.mid,
    trackName: transceiver.sender.track?.kind === "audio" ? "audio_track" : "video_track",
  }));
  sendAction(ws, "offer", { wakeId: id, sdp: offer.sdp, tracks });
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
