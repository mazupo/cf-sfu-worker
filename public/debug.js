// "Server state" panel for the demo pages. Reads /cloudflare/debug/* every 2 s while the panel
// is open. Those routes answer on localhost, or when the worker has DEBUG_STATE=true.

const SOCKET_STATES = ["connecting", "open", "closing", "closed"];

/**
 * @param {object} options
 * @param {HTMLDetailsElement} options.panel
 * @param {HTMLElement} options.body
 * @param {HTMLElement} options.updated
 * @param {() => string | null} options.url  returns the debug URL, or null when the form is incomplete
 * @param {() => string} options.key  the public key to send
 */
export function startDebugPanel({ panel, body, updated, url, key, intervalMs = 2000 }) {
  let timer = null;
  let running = false;

  async function refresh() {
    if (!panel.open || running) return;
    const target = url();
    if (!target) {
      body.replaceChildren(note("Fill in the form above first."));
      return;
    }
    running = true;
    try {
      const response = await fetch(target, { headers: { Authorization: `Bearer ${key()}` }, cache: "no-store" });
      const json = await response.json().catch(() => ({}));
      if (response.status === 404) {
        body.replaceChildren(note("The debug view is off on this host. Run locally, or set DEBUG_STATE=true on the worker."));
      } else if (!response.ok) {
        body.replaceChildren(note(json.error?.message ?? `Request failed (${response.status}).`));
      } else {
        body.replaceChildren(...render(json));
        updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
      }
    } catch (error) {
      body.replaceChildren(note(error.message));
    } finally {
      running = false;
    }
  }

  panel.addEventListener("toggle", () => {
    clearInterval(timer);
    if (panel.open) {
      refresh();
      timer = setInterval(refresh, intervalMs);
    }
  });
  return refresh;
}

function render(json) {
  const parts = [];
  if (json.room) {
    const room = json.room;
    parts.push(
      heading(
        `Room ${room.roomId}: ${room.members.length} device(s), ${room.viewers.length} viewer(s), alarm ${inSeconds(room.alarm, room.now)}`,
      ),
    );
    parts.push(deviceTable(json.devices));
    parts.push(viewerTable(room));
  } else if (json.device) {
    parts.push(heading(`Device ${json.device.deviceId}`));
    parts.push(deviceTable([json.device]));
  }
  const raw = document.createElement("details");
  raw.append(Object.assign(document.createElement("summary"), { textContent: "Raw JSON" }));
  raw.append(Object.assign(document.createElement("pre"), { className: "log", textContent: JSON.stringify(json, null, 2) }));
  parts.push(raw);
  return parts;
}

function deviceTable(devices) {
  return table(
    ["Device", "State", "Stored", "Gen", "Wake", "SFU session", "Socket", "Last ping", "Watched by", "Alarm", "Error"],
    devices.map((device) => {
      const now = device.now;
      const row = device.row;
      const open = device.sockets.find((socket) => socket.readyState === 1);
      return [
        device.deviceId,
        chip(device.info.state),
        row?.state ?? "—",
        row?.generation ?? "—",
        row?.wake_id ?? "—",
        short(row?.sfu_session_id),
        device.sockets.length
          ? device.sockets.map((socket) => `${SOCKET_STATES[socket.readyState] ?? socket.readyState}, ${ago(socket.connectedAt, now)}`).join("; ")
          : "none",
        open ? ago(open.lastPing ?? open.connectedAt, now) : "—",
        device.watchingRooms.length
          ? device.watchingRooms.map((watch) => `${watch.room_id} (${watch.subscribers} sub, ends ${inSeconds(watch.expires_at, now)})`).join("; ")
          : "nobody",
        inSeconds(device.alarm, now),
        row?.last_error ?? "",
      ];
    }),
  );
}

function viewerTable(room) {
  const now = room.now;
  return table(
    ["Viewer", "Socket", "Last ping", "Socket closed", "SFU session", "Offer pending", "Subscriptions"],
    room.viewers.map((viewer) => {
      const open = viewer.sockets.find((socket) => socket.readyState === 1);
      return [
        short(viewer.viewerId),
        viewer.sockets.length
          ? viewer.sockets.map((socket) => `${SOCKET_STATES[socket.readyState] ?? socket.readyState}, ${ago(socket.connectedAt, now)}`).join("; ")
          : "none",
        open ? ago(open.lastPing ?? open.connectedAt, now) : "—",
        viewer.socketClosedAt ? ago(viewer.socketClosedAt, now) : "",
        short(viewer.sfuSessionId),
        viewer.negotiating ? "yes" : "",
        viewer.subscriptions.map((sub) => `${sub.deviceId}/${sub.trackName} g${sub.generation} mid ${sub.mid}`).join("\n"),
      ];
    }),
  );
}

function table(headers, rows) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const element = document.createElement("table");
  const head = element.createTHead().insertRow();
  for (const header of headers) head.append(Object.assign(document.createElement("th"), { textContent: header }));
  const tbody = element.createTBody();
  if (rows.length === 0) {
    const cell = tbody.insertRow().insertCell();
    cell.colSpan = headers.length;
    cell.textContent = "none";
  }
  for (const values of rows) {
    const tr = tbody.insertRow();
    for (const value of values) {
      const cell = tr.insertCell();
      if (value instanceof Node) cell.append(value);
      else cell.textContent = String(value);
    }
  }
  wrap.append(element);
  return wrap;
}

function chip(state) {
  return Object.assign(document.createElement("span"), { className: `chip ${state}`, textContent: state });
}

function heading(text) {
  return Object.assign(document.createElement("p"), { className: "status", textContent: text });
}

function note(text) {
  return Object.assign(document.createElement("p"), { className: "empty", textContent: text });
}

function short(id) {
  return id ? `${String(id).slice(0, 8)}…` : "—";
}

function ago(timestamp, now) {
  if (!timestamp) return "—";
  return `${Math.max(0, Math.round((now - timestamp) / 1000))} s ago`;
}

function inSeconds(timestamp, now) {
  if (!timestamp) return "none";
  return `in ${Math.round((timestamp - now) / 1000)} s`;
}
