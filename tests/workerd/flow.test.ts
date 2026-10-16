import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { PUBLISH_TRACKS, connect, deviceToken, mockSfu, viewerToken, type TestSocket } from "./helpers";

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
  expect(await device.next("joined")).toMatchObject({ deviceId, state: "sleeping", rooms: [room] });

  const viewer = await connect(await viewerToken(viewerId, room));
  const { wakeId } = await device.next("wake");
  const joined = await viewer.next("joined");
  expect(joined).toMatchObject({ viewerId, room, resumed: false });
  expect(joined.devices).toEqual([expect.objectContaining({ deviceId, state: "waking" })]);

  device.send("offer", { wakeId, sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
  const answer = await device.next("answer");
  expect(answer).toEqual({ wakeId, generation: 1, sdp: "v=0 publisher-answer" });
  // Not live yet: the SFU has no media until the device's PeerConnection connects.
  expect(await viewer.device(deviceId, "waking")).toMatchObject({ generation: 1, tracks: [] });
  device.send("ready", { wakeId });
  expect(await viewer.device(deviceId, "live")).toMatchObject({ generation: 1, tracks: ["video_track", "audio_track"] });
  return { calls, device, viewer, wakeId };
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
      state: "sleeping",
      generation: 0,
      rooms: ["lab-a", "cam-1-only"],
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    });
    device.sendText("ping");
    expect(await device.nextText()).toBe("pong");
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
});

describe("watching", () => {
  test("a viewer wakes the device, subscribes, and the device sleeps after the last viewer leaves", async () => {
    const { calls, device, viewer, wakeId } = await liveDevice("cam-1", "cam-1-only", "v1");

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
      { deviceId: "cam-1", trackName: "video_track", mid: "100", generation: 1 },
      { deviceId: "cam-1", trackName: "audio_track", mid: "101", generation: 1 },
    ]);
    // The viewer pulled from the device's session; it never sees that session ID.
    const pull = calls.filter((call) => call.path.endsWith("/tracks/new"))[1]!;
    expect(pull.body.tracks).toEqual([
      { location: "remote", sessionId: "session-1", trackName: "video_track" },
      { location: "remote", sessionId: "session-1", trackName: "audio_track" },
    ]);
    expect(JSON.stringify(viewer.messages)).not.toContain("session-1");

    viewer.send("leave");
    expect((await viewer.closed()).code).toBe(1000);

    // Nothing happens before the linger time is over.
    expect(device.has("sleep")).toBe(false);
    await expireDeviceTimer("cam-1", "linger_until");
    expect(await device.next("sleep")).toEqual({ wakeId });
    device.send("unpublished", { wakeId });
    device.close();
  });

  test("a viewer that comes back within the linger time keeps the device live", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a", "v1");
    viewer.send("leave");
    await viewer.closed();

    const again = await connect(await viewerToken("v2", "lab-a"));
    expect((await again.next("joined")).devices).toEqual([expect.objectContaining({ deviceId: "cam-1", state: "live" })]);
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
    expect(await third.next("error")).toMatchObject({ code: "viewer_limit", action: "subscribe" });
    for (const socket of [viewer, second, third, device]) socket.close();
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
    expect(await viewer.device("cam-1", "sleeping")).toMatchObject({ lastError: "wake_timeout" });
    viewer.close();
    device.close();
  });

  test("a device that reconnects with its wake_id keeps publishing", async () => {
    const { device, viewer, wakeId } = await liveDevice("cam-1", "lab-a", "v1");
    const reconnected = await connect(await deviceToken("cam-1", ["lab-a"], wakeId));
    expect(await reconnected.next("joined")).toMatchObject({ state: "live", generation: 1 });
    expect((await device.closed()).code).toBe(4000);
    expect(reconnected.has("wake")).toBe(false);
    reconnected.close();
    viewer.close();
  });

  test("the generation goes up once per publication, not on sleep", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a", "v1");
    viewer.send("leave");
    await viewer.closed();
    await expireDeviceTimer("cam-1", "linger_until");
    const { wakeId: oldWake } = await device.next("sleep");
    device.send("unpublished", { wakeId: oldWake });

    const again = await connect(await viewerToken("v2", "lab-a"));
    await again.next("joined");
    const { wakeId } = await device.next("wake");
    device.send("offer", { wakeId, sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
    expect(await device.next("answer")).toMatchObject({ generation: 2 });
    again.close();
    device.close();
  });

  test("a restarted device without a wake_id starts a new publication", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a", "v1");
    const restarted = await connect(await deviceToken("cam-1", ["lab-a"]));
    expect(await restarted.next("joined")).toMatchObject({ state: "waking", generation: 1 });
    const { wakeId } = await restarted.next("wake");
    expect(await viewer.device("cam-1", "waking")).toMatchObject({ generation: 1, tracks: [] });
    restarted.send("offer", { wakeId, sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
    expect(await restarted.next("answer")).toMatchObject({ generation: 2 });
    await device.closed();
    restarted.close();
    viewer.close();
  });
});
