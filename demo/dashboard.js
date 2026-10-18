// Dashboard: every room this worker serves, from /cloudflare/admin/*. When the worker has an
// ADMIN_KEY secret, enter it here; without one, the dashboard answers on localhost only.
import { renderRoom } from "./debug.js";
import { ago, clock } from "./time.js";

/** A Durable Object busy with the SFU can take long to answer. The page keeps its last data meanwhile. */
const TIMEOUT_MS = 5000;
const KEY_STORAGE = "cf-sfu-worker.adminKey";
const EVERY_STORAGE = "cf-sfu-worker.refreshEvery";

const keyInput = document.getElementById("admin-key");
const everySelect = document.getElementById("refresh-every");
const deploymentEl = document.getElementById("deployment");
const totalsEl = document.getElementById("totals");
const roomsEl = document.getElementById("rooms");
const statusEl = document.getElementById("status");

/** Rooms opened to show their details, their last details, and the ones being read. */
const opened = new Set();
const details = new Map();
const loading = new Set();
let listing = false;
let lastList = null;
let timer = null;

try {
  keyInput.value = sessionStorage.getItem(KEY_STORAGE) ?? "";
  const every = localStorage.getItem(EVERY_STORAGE);
  if ([...everySelect.options].some((option) => option.value === every)) everySelect.value = every;
} catch {
  // ignore
}
everySelect.addEventListener("change", () => {
  try {
    localStorage.setItem(EVERY_STORAGE, everySelect.value);
  } catch {
    // ignore
  }
  schedule();
});
document.getElementById("refresh-now").addEventListener("click", () => refresh());
// A hidden tab polls for nobody. Coming back shows fresh data, unless refreshing is off.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Number(everySelect.value) > 0) refresh();
  schedule();
});
keyInput.addEventListener("input", () => {
  try {
    sessionStorage.setItem(KEY_STORAGE, keyInput.value);
  } catch {
    // ignore
  }
  refresh();
});
document.getElementById("key-form").addEventListener("submit", (event) => event.preventDefault());

function get(path) {
  const key = keyInput.value.trim();
  return fetch(`/cloudflare/admin${path}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** The room list. The details of open rooms load on their own, so a slow room holds up nothing. */
async function refresh() {
  if (listing) return;
  listing = true;
  try {
    const response = await get("/rooms");
    const json = await response.json().catch(() => ({}));
    if (response.status === 404) {
      showProblem("The dashboard answers only on localhost. Set the ADMIN_KEY secret on the worker to use it here.");
      return;
    }
    if (response.status === 401) {
      showProblem("Enter the worker's ADMIN_KEY.");
      return;
    }
    if (!response.ok) {
      showProblem(json.error?.message ?? `Request failed (${response.status}).`);
      return;
    }
    // Rooms that went away close.
    for (const roomId of opened) {
      if (!json.rooms.some((room) => room.roomId === roomId)) opened.delete(roomId);
    }
    lastList = json;
    render(json);
    statusEl.textContent = `updated ${clock()}`;
    for (const roomId of opened) loadDetails(roomId);
  } catch (error) {
    statusEl.textContent = error.name === "TimeoutError" ? "The worker is slow to answer; showing the last data." : error.message;
  } finally {
    listing = false;
  }
}

async function loadDetails(roomId) {
  if (loading.has(roomId)) return;
  loading.add(roomId);
  try {
    const answer = await get(`/rooms/${encodeURIComponent(roomId)}`);
    if (answer.ok) details.set(roomId, await answer.json());
  } catch {
    // Keep the last details.
  } finally {
    loading.delete(roomId);
    if (lastList && opened.has(roomId)) render(lastList);
  }
}

function showProblem(text) {
  statusEl.textContent = text;
  totalsEl.replaceChildren();
  roomsEl.replaceChildren();
}

function render(list) {
  deploymentEl.textContent = `${list.host} · SFU app ${list.appId}`;
  const { totals } = list;
  totalsEl.replaceChildren(
    total("Rooms", totals.rooms),
    total("Viewers", totals.viewers, [totals.away && `${totals.away} away`, `${totals.ipcViewers} with IPC`]),
    total("Devices", totals.devices, [`${totals.liveDevices} live`]),
  );

  const rows = [];
  for (const room of list.rooms) {
    const isOpen = opened.has(room.roomId);
    const row = document.createElement("tr");
    row.className = "room";
    row.tabIndex = 0;
    row.setAttribute("aria-expanded", String(isOpen));
    const toggle = () => {
      if (opened.has(room.roomId)) {
        opened.delete(room.roomId);
      } else {
        opened.add(room.roomId);
        loadDetails(room.roomId);
      }
      render(lastList ?? list);
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
    const live = room.devices.filter((device) => device.state === "live").length;
    row.append(
      cell(`${isOpen ? "▾" : "▸"} ${room.roomId}`),
      cell(deviceList(room.devices, live)),
      cell(`${room.viewers}${room.away ? ` (+${room.away} away)` : ""}, ${room.ipcViewers} with IPC`),
      cell(ago(room.updatedAt, list.now)),
    );
    rows.push(row);
    if (isOpen) {
      const more = document.createElement("tr");
      more.className = "room-details";
      const td = document.createElement("td");
      td.colSpan = 4;
      const body = document.createElement("div");
      body.className = "debug-body";
      const json = details.get(room.roomId);
      body.append(...(json ? renderRoom(json) : [Object.assign(document.createElement("p"), { className: "empty", textContent: "Loading…" })]));
      td.append(body);
      more.append(td);
      rows.push(more);
    }
  }
  if (rows.length === 0) {
    const row = document.createElement("tr");
    const td = cell("No rooms have viewers or devices right now.");
    td.colSpan = 4;
    td.className = "empty";
    row.append(td);
    rows.push(row);
  }
  roomsEl.replaceChildren(...rows);
}

function total(label, value, notes = []) {
  const card = document.createElement("div");
  card.className = "panel total";
  card.append(
    Object.assign(document.createElement("span"), { className: "label", textContent: label }),
    Object.assign(document.createElement("span"), { className: "value", textContent: String(value) }),
    Object.assign(document.createElement("span"), { className: "status", textContent: notes.filter(Boolean).join(" · ") }),
  );
  return card;
}

/** "1 live / 2" and each device with its state, as far as the room knows it. */
function deviceList(devices, live) {
  const wrap = document.createElement("div");
  wrap.append(Object.assign(document.createElement("div"), { textContent: `${live} live / ${devices.length}` }));
  for (const device of devices) {
    const line = document.createElement("div");
    line.append(`${device.deviceId} `);
    const state = device.state ?? "unwatched";
    line.append(Object.assign(document.createElement("span"), { className: `chip ${state}`, textContent: state }));
    wrap.append(line);
  }
  return wrap;
}

function cell(content) {
  const td = document.createElement("td");
  if (content instanceof Node) td.append(content);
  else td.textContent = content;
  return td;
}

/**
 * Each refresh is a Worker request and a Registry request, plus one Room request per open room,
 * so a longer interval saves requests.
 */
function schedule() {
  clearInterval(timer);
  timer = null;
  const every = Number(everySelect.value);
  if (every > 0 && !document.hidden) timer = setInterval(refresh, every);
}

refresh();
schedule();
