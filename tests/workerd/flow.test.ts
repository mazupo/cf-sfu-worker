import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";

import { CloseCode, ErrorCode, ViewerRequest } from "../../src/proto/cloudflare";
import { CLAIMS_HEADER } from "../../src/server/socket";
import {
  connect,
  deviceToken,
  mockSfu,
  PUBLISH_TRACKS,
  publisherSessions,
  state_,
  TestSocket,
  viewerToken,
} from "./helpers";

/** The request the worker hands a Durable Object for this token, with its claims. */
function socketRequest(token: string): Request {
  const claims = atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"));
  return new Request("http://localhost/cloudflare/rtc", {
    headers: { Upgrade: "websocket", [CLAIMS_HEADER]: encodeURIComponent(claims) },
  });
}

/** The kind of each message a socket got so far, in order: "joined", "wake", ... */
const kinds = (ws: TestSocket) => ws.messages.map((message) => Object.keys(message)[0]);

/** Moves a Device DO timer into the past and runs its alarm. */
async function expireDeviceTimer(deviceId: string, column: "linger_until" | "wake_deadline"): Promise<void> {
  const stub = env.DEVICES.getByName(deviceId);
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(`UPDATE device SET ${column} = ?`, Date.now() - 1);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

/** Connects a device, a viewer, and answers the device's wake with an offer. */
async function liveDevice(deviceId: string, room: string, viewerId: string) {
  const calls = mockSfu();
  const device = await connect(await deviceToken(deviceId, [room]));
  expect(await device.next("joined")).toMatchObject({ deviceId, state: state_("sleeping"), rooms: [room] });

  const viewer = await connect(await viewerToken(viewerId, room));
  await device.next("wake");
  const joined = await viewer.next("joined");
  expect(joined).toMatchObject({ viewerId, room, resumed: false });
  expect(joined.devices).toEqual([expect.objectContaining({ deviceId, state: state_("waking") })]);

  device.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
  const answer = await device.next("answer");
  expect(answer).toEqual({ generation: 1, sdp: "v=0 publisher-answer" });
  // Not live yet: the SFU has no media until the device's PeerConnection connects.
  expect(await viewer.device(deviceId, "waking")).toMatchObject({ generation: 1, tracks: [] });
  device.send("ready", {});
  expect(await viewer.device(deviceId, "live")).toMatchObject({ generation: 1, tracks: ["video_track", "audio_track"] });
  return { calls, device, viewer };
}

async function subscribeAll(viewer: TestSocket, deviceId: string) {
  viewer.send("subscribe", {
    tracks: [
      { deviceId, trackName: "video_track" },
      { deviceId, trackName: "audio_track" },
    ],
  });
  const offer = await viewer.next("offer");
  viewer.send("answer", { sdp: "v=0 viewer-answer" });
  const subscribed = await viewer.next("subscribed");
  return { offer, subscribed };
}

describe("device socket", () => {
  test("joins its rooms, sleeps, and answers ping without waking the object", async () => {
    const device = await connect(await deviceToken("cam-1", ["lab-a", "cam-1-only"]));
    expect(await device.next("joined")).toMatchObject({
      deviceId: "cam-1",
      state: state_("sleeping"),
      generation: 0,
      rooms: ["lab-a", "cam-1-only"],
      iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"], username: "", credential: "" }],
    });
    device.sendText("ping");
    expect(await device.nextText()).toBe("pong");
    device.close();
  });

  test("a frame that is not a DeviceRequest gets an invalid-message error", async () => {
    const device = await connect(await deviceToken("cam-1", ["lab-a"]));
    await device.next("joined");
    device.sendText("hello");
    expect(await device.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_INVALID_MESSAGE });
    device.ws.send(new Uint8Array([0xff, 0xff, 0xff]));
    expect(await device.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_INVALID_MESSAGE });
    device.close();
  });

  test("a second connection with the same device_id replaces the first", async () => {
    const first = await connect(await deviceToken("cam-1", ["lab-a"]));
    await first.next("joined");
    const second = await connect(await deviceToken("cam-1", ["lab-a"]));
    await second.next("joined");
    expect((await first.closed()).code).toBe(4000);
    second.close();
  });

  test("a device with another secret cannot take the ID of a live one, but can once it is gone", async () => {
    mockSfu();
    const first = await connect(await deviceToken("cam-1", ["lab-a"]));
    await first.next("joined");
    const other = await connect(await deviceToken("cam-1", ["lab-a"], undefined, "another-device-secret"));
    expect((await other.closed()).code).toBe(CloseCode.CLOSE_CODE_ID_IN_USE);
    expect(other.has("joined")).toBe(false);
    expect(first.closeEvent).toBeNull();

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const later = await connect(await deviceToken("cam-1", ["lab-a"], undefined, "another-device-secret"));
    expect(await later.next("joined")).toMatchObject({ deviceId: "cam-1" });
    later.close();
  });

  test("a viewer with another secret cannot take the ID of a live one, nor resume it once it is gone", async () => {
    mockSfu();
    const first = await connect(await viewerToken("v1", "lab-a"));
    await first.next("joined");
    const other = await connect(await viewerToken("v1", "lab-a", false, "someone-elses-secret"));
    expect((await other.closed()).code).toBe(CloseCode.CLOSE_CODE_ID_IN_USE);
    expect(first.closeEvent).toBeNull();

    // It drops without leaving: only its own secret could resume it within 30 s.
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const later = await connect(await viewerToken("v1", "lab-a", false, "someone-elses-secret"));
    expect((await later.next("joined")).resumed).toBe(false);
    later.close();
  });

  test("the late close of a viewer socket someone else took over does not mark the new viewer away", async () => {
    mockSfu();
    const room = env.ROOMS.getByName("lab-a");
    const first = await connect(await viewerToken("v1", "lab-a"));
    await first.next("joined");
    // It stopped pinging: the socket is still open, but no longer live.
    const old = await runInDurableObject(room, async (_instance, state) => {
      const ws = state.getWebSockets("v1")[0]!;
      ws.serializeAttachment({ viewerId: "v1", connectedAt: Date.now() - 60_000 });
      return ws;
    });
    const request = socketRequest(await viewerToken("v1", "lab-a", false, "someone-elses-secret"));
    const closedAt = await runInDurableObject(room, async (instance, state) => {
      // The old socket's close comes in while the new viewer waits for the room's devices.
      const watchAll = (instance as any).watchAll.bind(instance);
      (instance as any).watchAll = async (now: number) => {
        await instance.webSocketClose(old, CloseCode.CLOSE_CODE_REPLACED);
        return watchAll(now);
      };
      const second = new TestSocket((await instance.fetch(request)).webSocket!, "viewer");
      expect((await second.next("joined")).resumed).toBe(false);
      const value = state.storage.sql.exec<{ socket_closed_at: number | null }>("SELECT socket_closed_at FROM viewers").one().socket_closed_at;
      second.close();
      return value;
    });
    expect(closedAt).toBeNull();
  });

  test("a reconnecting device gets joined before a wake, even when a room watches meanwhile", async () => {
    mockSfu();
    const first = await connect(await deviceToken("cam-1", ["lab-a"]));
    await first.next("joined");
    const request = socketRequest(await deviceToken("cam-1", ["lab-a"]));
    // The new connection waits for its rooms; a room's watch() comes in right then.
    const received = await runInDurableObject(env.DEVICES.getByName("cam-1"), async (instance) => {
      const fetching = instance.fetch(request);
      await instance.watch("lab-a", []);
      const second = new TestSocket((await fetching).webSocket!, "device");
      await vi.waitFor(() => expect(second.has("wake")).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 200));
      second.close();
      return kinds(second);
    });
    expect(received[0]).toBe("joined");
    expect(received.filter((kind) => kind === "wake")).toHaveLength(1);
    expect(first.has("wake")).toBe(false);
  });

  test("a reconnecting device does not look offline to its rooms while it joins", async () => {
    mockSfu();
    const first = await connect(await deviceToken("cam-1", ["lab-a"]));
    await first.next("joined");
    const request = socketRequest(await deviceToken("cam-1", ["lab-a"]));
    // The old socket is closed and the new one waits for its rooms, e.g. after a network change.
    const during = await runInDurableObject(env.DEVICES.getByName("cam-1"), async (instance) => {
      const fetching = instance.fetch(request);
      const info = await instance.getInfo();
      const second = new TestSocket((await fetching).webSocket!, "device");
      await second.next("joined");
      second.close();
      return info.state;
    });
    expect(during).toBe(state_("sleeping"));
  });

  test("what a replaced viewer socket still sends, such as a late leave, is ignored", async () => {
    mockSfu();
    const room = env.ROOMS.getByName("lab-a");
    const first = await connect(await viewerToken("v1", "lab-a"));
    await first.next("joined");
    const old = await runInDurableObject(room, async (_instance, state) => state.getWebSockets("v1")[0]!);
    const second = await connect(await viewerToken("v1", "lab-a"));
    expect((await second.next("joined")).resumed).toBe(true);
    // The old page sent leave before it heard that it was replaced, so it reaches the closed socket.
    const leave = ViewerRequest.encode(ViewerRequest.fromPartial({ leave: {} })).finish();
    const viewers = await runInDurableObject(room, async (instance, state) => {
      expect(old.readyState).not.toBe(WebSocket.OPEN);
      await instance.webSocketMessage(old, leave.slice().buffer);
      return state.storage.sql.exec<{ viewer_id: string }>("SELECT viewer_id FROM viewers").toArray();
    });
    expect(viewers).toEqual([{ viewer_id: "v1" }]);
    expect(second.has("error")).toBe(false);
    second.close();
  });
});

describe("watching", () => {
  test("a viewer wakes the device, subscribes, and the device sleeps after the last viewer leaves", async () => {
    const { calls, device, viewer } = await liveDevice("cam-1", "cam-1-only", "v1");

    // The device published through its own SFU session.
    const publish = calls.find((call) => call.path.endsWith("/tracks/new"))!;
    expect(publish.body.tracks).toEqual([
      { location: "local", mid: "0", trackName: "video_track" },
      { location: "local", mid: "1", trackName: "audio_track" },
    ]);

    const { offer, subscribed } = await subscribeAll(viewer, "cam-1");
    expect(offer.sdp).toBe("v=0 subscriber-offer");
    expect(offer.sessionReset).toBe(false);
    expect(subscribed.tracks).toEqual([
      { deviceId: "cam-1", trackName: "video_track", mid: "100", generation: 1, viewerId: "", room: "" },
      { deviceId: "cam-1", trackName: "audio_track", mid: "101", generation: 1, viewerId: "", room: "" },
    ]);
    // The viewer pulled from the device's session; it never sees that session ID.
    const [publisher] = publisherSessions(calls);
    const pull = calls.filter((call) => call.path.endsWith("/tracks/new"))[1]!;
    expect(pull.body.tracks).toEqual([
      { location: "remote", sessionId: publisher, trackName: "video_track" },
      { location: "remote", sessionId: publisher, trackName: "audio_track" },
    ]);
    expect(JSON.stringify(viewer.messages)).not.toContain(publisher);
    // One session for the device (made with the wake) and one for the viewer (made at join).
    expect(calls.filter((call) => call.path.endsWith("/sessions/new"))).toHaveLength(2);

    viewer.send("leave");
    expect((await viewer.closed()).code).toBe(1000);

    // Nothing happens before the linger time is over.
    expect(device.has("sleep")).toBe(false);
    await expireDeviceTimer("cam-1", "linger_until");
    expect(await device.next("sleep")).toEqual({});
    device.close();
  });

  test("a viewer that comes back within the linger time keeps the device live", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a", "v1");
    viewer.send("leave");
    await viewer.closed();

    const again = await connect(await viewerToken("v2", "lab-a"));
    expect((await again.next("joined")).devices).toEqual([expect.objectContaining({ deviceId: "cam-1", state: state_("live") })]);
    await runDurableObjectAlarm(env.DEVICES.getByName("cam-1"));
    expect(device.has("sleep")).toBe(false);
    again.close();
    device.close();
  });

  test("a viewer reconnecting with the same viewer_id resumes its subscriptions", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a", "v1");
    const { subscribed } = await subscribeAll(viewer, "cam-1");
    viewer.close();

    const resumed = await connect(await viewerToken("v1", "lab-a"));
    const joined = await resumed.next("joined");
    expect(joined.resumed).toBe(true);
    expect(joined.subscriptions).toEqual(subscribed.tracks);
    resumed.close();
    device.close();
  });

  test("each device accepts only MAX_VIEWERS_PER_DEVICE subscribers", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a", "v1");
    await subscribeAll(viewer, "cam-1");
    const second = await connect(await viewerToken("v2", "lab-a"));
    await second.next("joined");
    await subscribeAll(second, "cam-1");

    const third = await connect(await viewerToken("v3", "lab-a"));
    await third.next("joined");
    third.send("subscribe", { tracks: [{ deviceId: "cam-1", trackName: "video_track" }] });
    expect(await third.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_VIEWER_LIMIT, request: "subscribe" });
    for (const socket of [viewer, second, third, device]) socket.close();
  });

  test("viewers who subscribe at the same time all count toward the limit", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a", "v1");
    const viewers = [viewer];
    for (const viewerId of ["v2", "v3"]) {
      const other = await connect(await viewerToken(viewerId, "lab-a"));
      await other.next("joined");
      viewers.push(other);
    }
    for (const socket of viewers) socket.send("subscribe", { tracks: [{ deviceId: "cam-1", trackName: "video_track" }] });
    const outcomes = await Promise.all(
      viewers.map((socket) =>
        vi.waitFor(() => {
          const message = socket.messages.find((item) => item.offer || item.error);
          if (!message) throw new Error("no reply yet");
          return message.offer ? "offer" : message.error.code;
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome === "offer")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome === ErrorCode.ERROR_CODE_VIEWER_LIMIT)).toHaveLength(1);

    const counted = await runInDurableObject(env.DEVICES.getByName("cam-1"), async (_instance, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM room_viewers WHERE room_id = 'lab-a'").one(),
    );
    expect(counted.n).toBe(2);
    for (const socket of [...viewers, device]) socket.close();
  });

  test("a viewer stops counting once it leaves, and a renewal drops viewers the room no longer has", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a", "v1");
    await subscribeAll(viewer, "cam-1");
    const second = await connect(await viewerToken("v2", "lab-a"));
    await second.next("joined");
    await subscribeAll(second, "cam-1");
    second.send("leave");
    await second.closed();

    const third = await connect(await viewerToken("v3", "lab-a"));
    await third.next("joined");
    await subscribeAll(third, "cam-1");

    // A row the room lost track of, e.g. a subscribe cut short by a deploy, goes with the next renewal.
    const deviceStub = env.DEVICES.getByName("cam-1");
    await runInDurableObject(deviceStub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM room_viewers WHERE viewer_id = 'v3'");
      state.storage.sql.exec("INSERT INTO room_viewers VALUES ('lab-a', 'ghost', ?)", Date.now() - 120_000);
      state.storage.sql.exec("INSERT INTO room_viewers VALUES ('lab-a', 'v3', ?)", Date.now() - 120_000);
    });
    await runInDurableObject(env.ROOMS.getByName("lab-a"), (_instance, state) => {
      state.storage.sql.exec("UPDATE devices SET lease_renewed_at = 0");
    });
    await runDurableObjectAlarm(env.ROOMS.getByName("lab-a"));
    const viewers = await runInDurableObject(deviceStub, async (_instance, state) =>
      state.storage.sql.exec<{ viewer_id: string }>("SELECT viewer_id FROM room_viewers ORDER BY viewer_id").toArray(),
    );
    expect(viewers.map((row) => row.viewer_id)).toEqual(["v1", "v3"]);
    for (const socket of [viewer, third, device]) socket.close();
  });

  test("a wake that gets no offer is sent again, then reported", async () => {
    mockSfu();
    const device = await connect(await deviceToken("cam-1", ["lab-a"]));
    await device.next("joined");
    const viewer = await connect(await viewerToken("v1", "lab-a"));
    const first = await device.next("wake");
    await viewer.next("joined");

    await expireDeviceTimer("cam-1", "wake_deadline");
    expect(await device.next("wake")).toEqual(first);

    await expireDeviceTimer("cam-1", "wake_deadline");
    expect(await viewer.device("cam-1", "sleeping")).toMatchObject({ lastError: ErrorCode.ERROR_CODE_WAKE_TIMEOUT });
    viewer.close();
    device.close();
  });

  test("an offer that finds the wake-time session expired publishes on a new session", async () => {
    const calls = mockSfu({ expireFirstPublish: true });
    const device = await connect(await deviceToken("cam-1", ["lab-a"]));
    await device.next("joined");
    const viewer = await connect(await viewerToken("v1", "lab-a"));
    await device.next("wake");
    await viewer.next("joined");

    device.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
    expect(await device.next("answer")).toMatchObject({ generation: 1 });
    const [expired, used] = publisherSessions(calls);
    expect(used).toBeDefined();
    expect(used).not.toBe(expired);
    expect(device.has("error")).toBe(false);
    viewer.close();
    device.close();
  });

  test("a device that reconnects with the generation of its answer keeps publishing", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a", "v1");
    const reconnected = await connect(await deviceToken("cam-1", ["lab-a"], 1));
    expect(await reconnected.next("joined")).toMatchObject({ state: state_("live"), generation: 1 });
    expect((await device.closed()).code).toBe(4000);
    expect(reconnected.has("wake")).toBe(false);
    reconnected.close();
    viewer.close();
  });

  test("a device that reconnects with an older generation starts over", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a", "v1");
    // Its answer for generation 2 was lost with the old socket, so it still knows generation 1.
    device.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
    await device.next("answer");
    const reconnected = await connect(await deviceToken("cam-1", ["lab-a"], 1));
    expect(await reconnected.next("joined")).toMatchObject({ state: state_("sleeping"), generation: 2 });
    await reconnected.next("wake");
    reconnected.close();
    viewer.close();
  });

  test("the generation goes up once per publication, not on sleep", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a", "v1");
    viewer.send("leave");
    await viewer.closed();
    await expireDeviceTimer("cam-1", "linger_until");
    await device.next("sleep");

    // Messages that crossed the sleep: the worker does not take them as a new publication.
    device.send("ready", {});
    expect(await device.next("sleep")).toEqual({});
    device.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
    expect(await device.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_WAKE_STALE, request: "offer" });

    const again = await connect(await viewerToken("v2", "lab-a"));
    await again.next("joined");
    await device.next("wake");
    device.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
    expect(await device.next("answer")).toMatchObject({ generation: 2 });
    again.close();
    device.close();
  });

  test("a device that left every room is forgotten, and its new tracks are pulled when it comes back", async () => {
    const { calls, device, viewer } = await liveDevice("cam-1", "lab-a", "v1");
    const { subscribed } = await subscribeAll(viewer, "cam-1");
    device.ws.close(1000, "bye");
    expect((await viewer.next("members")).devices).toEqual([]);

    // Its tracks stay, so the viewer can still unsubscribe them and the SFU closes them.
    const room = env.ROOMS.getByName("lab-a");
    const generations = await runInDurableObject(room, async (_instance, state) =>
      state.storage.sql.exec<{ generation: number }>("SELECT generation FROM subscriptions").toArray(),
    );
    expect(generations.map((row) => row.generation)).toEqual([0, 0]);

    // Once the tokens it used have expired, the Device DO keeps nothing.
    const stub = env.DEVICES.getByName("cam-1");
    await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("UPDATE used_tokens SET expires_at = 0"));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const tables = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray(),
    );
    expect(tables).toEqual([]);

    // Back with generation 1 again. The old rows have 0, so its tracks are pulled anew.
    const back = await connect(await deviceToken("cam-1", ["lab-a"]));
    expect(await back.next("joined")).toMatchObject({ generation: 0, rooms: ["lab-a"] });
    await back.next("wake");
    back.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
    expect(await back.next("answer")).toMatchObject({ generation: 1 });
    back.send("ready", {});
    await viewer.device("cam-1", "live");
    const before = calls.filter((call) => call.path.endsWith("/tracks/new")).length;
    viewer.send("subscribe", { tracks: [{ deviceId: "cam-1", trackName: "video_track" }] });
    await viewer.next("offer");
    viewer.send("answer", { sdp: "v=0 viewer-answer-2" });
    await viewer.next("subscribed");
    expect(calls.filter((call) => call.path.endsWith("/tracks/new")).length).toBe(before + 1);

    viewer.send("unsubscribe", { mids: subscribed.tracks.map((track: { mid: string }) => track.mid) });
    await viewer.next("offer");
    const closed = calls.filter((call) => call.path.endsWith("/tracks/close")).at(-1)!;
    expect(closed.body.tracks).toHaveLength(2);
    for (const socket of [viewer, back]) socket.close();
  });

  test("a restarted device without a generation starts a new publication", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a", "v1");
    const restarted = await connect(await deviceToken("cam-1", ["lab-a"]));
    await restarted.next("wake");
    // The old publication is over. `joined` came before the new wake, so the device has its
    // ICE servers when it builds the PeerConnection.
    expect(Object.keys(restarted.messages[0] ?? {})).toEqual(["joined"]);
    expect(await restarted.next("joined")).toMatchObject({ state: state_("sleeping"), generation: 1 });
    expect(await viewer.device("cam-1", "waking")).toMatchObject({ generation: 1, tracks: [] });
    restarted.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
    expect(await restarted.next("answer")).toMatchObject({ generation: 2 });
    await device.closed();
    restarted.close();
    viewer.close();
  });
});
