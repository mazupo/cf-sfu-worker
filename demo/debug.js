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
  // The body is rebuilt on every refresh, so remember what the user opened and scrolled.
  const raw = { open: false, scrollTop: 0 };

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
      } else if (selecting(body)) {
        // Rebuilding would drop the selection, so wait until the user has copied it.
        updated.textContent = "paused while text is selected";
      } else {
        raw.scrollTop = body.querySelector("details.raw pre")?.scrollTop ?? raw.scrollTop;
        body.replaceChildren(...render(json, raw));
        const pre = body.querySelector("details.raw pre");
        if (pre) pre.scrollTop = raw.scrollTop;
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

function selecting(element) {
  const selection = getSelection();
  return selection !== null && !selection.isCollapsed && element.contains(selection.anchorNode);
}

function render(json, raw) {
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
  const details = Object.assign(document.createElement("details"), { className: "raw", open: raw.open });
  details.addEventListener("toggle", () => (raw.open = details.open));
  details.append(Object.assign(document.createElement("summary"), { textContent: "Raw JSON" }));
  details.append(Object.assign(document.createElement("pre"), { className: "log", textContent: JSON.stringify(json, null, 2) }));
  parts.push(details);
  return parts;
}

function deviceTable(devices) {
  return table(
    ["Device", "State", "Stored", "Gen", "SFU session", "Socket", "Last ping", "Watched by", "Alarm", "Error"],
    devices.map((device) => {
      const now = device.now;
      const row = device.row;
      const open = device.sockets.find((socket) => socket.readyState === 1);
      return [
        device.deviceId,
        chip(device.info.state),
        row?.state ?? "—",
        row?.generation ?? "—",
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
    ["Viewer", "State", "SFU session", "IPC", "Socket", "Last ping", "Subscriptions"],
    room.viewers.map((viewer) => {
      const open = viewer.sockets.find((socket) => socket.readyState === 1);
      return [
        short(viewer.viewerId),
        chip(viewer.state),
        short(viewer.sfuSessionId),
        viewer.dataChannels ? "yes" : "no",
        viewer.sockets.length
          ? viewer.sockets.map((socket) => `${SOCKET_STATES[socket.readyState] ?? socket.readyState}, ${ago(socket.connectedAt, now)}`).join("; ")
          : "none",
        open ? ago(open.lastPing ?? open.connectedAt, now) : "—",
        subscriptionList(viewer),
      ];
    }),
  );
}

/** One line per track, then one per device whose data channels the viewer has, marked when it controls that device. */
function subscriptionList(viewer) {
  const list = document.createElement("div");
  for (const sub of viewer.subscriptions) list.append(line(`${sub.deviceId}/${sub.trackName} mid ${sub.mid}`));
  for (const data of viewer.data) {
    const item = line(`${data.deviceId} ${data.channels.map((channel) => `${channel.label} id ${channel.id}`).join(", ")} `);
    if (data.canReply) item.append(chip("control"));
    list.append(item);
  }
  return list;
}

function line(text) {
  return Object.assign(document.createElement("div"), { textContent: text });
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

/** Long IDs, such as SFU sessions and random viewer IDs, show their first 8 characters. */
function short(id) {
  if (!id) return "—";
  const text = String(id);
  return text.length > 12 ? `${text.slice(0, 8)}…` : text;
}

function ago(timestamp, now) {
  if (!timestamp) return "—";
  return `${Math.max(0, Math.round((now - timestamp) / 1000))} s ago`;
}

function inSeconds(timestamp, now) {
  if (!timestamp) return "none";
  return `in ${Math.round((timestamp - now) / 1000)} s`;
}
