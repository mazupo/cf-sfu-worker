import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { ErrorCode } from "../../src/proto/cloudflare";
import {
  connect,
  deviceToken,
  mockSfu,
  PUBLISH_TRACKS,
  publisherSessions,
  sessionOf,
  type SfuCall,
  state_,
  type TestSocket,
  viewerToken,
} from "./helpers";

const LOSSY = { dataChannelName: "_lossy", ordered: false, maxRetransmits: 0 };
const RELIABLE = { dataChannelName: "_reliable", ordered: true };

async function setup(rooms = ["lab-a"]) {
  const calls = mockSfu();
  const device = await connect(await deviceToken("cam-1", rooms));
  await device.next("joined");
  return { calls, device };
}

/** Joins and sends its own offer, as every viewer page does. */
async function earlyViewer(viewerId: string, room = "lab-a", dataChannels = true): Promise<TestSocket> {
  const viewer = await connect(await viewerToken(viewerId, room, dataChannels));
  expect(await viewer.next("joined")).toMatchObject({ viewerId, room });
  viewer.send("offer", { sdp: "v=0 viewer-offer" });
  expect(await viewer.next("answer")).toEqual({ sdp: "v=0 datachannel-answer" });
  return viewer;
}

/** A viewer whose token asks for data channels. */
const dataViewer = (viewerId: string, room = "lab-a") => earlyViewer(viewerId, room, true);

/** Answers the wake with an offer that has data channels, then goes live. */
async function publishWithData(device: TestSocket) {
  await device.next("wake");
  device.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS, dataChannels: true });
  await device.next("answer");
  const channels = await device.next("channels");
  device.send("ready", {});
  return { channels };
}

async function openData(viewer: TestSocket, deviceId = "cam-1") {
  await viewer.device(deviceId, "live");
  viewer.send("subscribe", { data: [deviceId] });
  const subscribed = await viewer.next("subscribed");
  return subscribed.data.find((data: { deviceId: string }) => data.deviceId === deviceId);
}

/** Waits for a `subscribed` whose cam-1 channels have this canReply. */
async function canReply(viewer: TestSocket, value: boolean) {
  while (true) {
    const subscribed = await viewer.next("subscribed");
    const data = subscribed.data.find((entry: { deviceId: string }) => entry.deviceId === "cam-1");
    if (data && data.canReply === value) return data;
  }
}

/** Waits for a `device` message about cam-1 that passes the check. */
async function info(viewer: TestSocket, check: (device: any) => boolean) {
  while (true) {
    const device = await viewer.next("device");
    if (device.deviceId === "cam-1" && check(device)) return device;
  }
}

/** Takes control of cam-1 and confirms it, as the viewer page does. */
async function control(viewer: TestSocket) {
  viewer.send("takeControl", { deviceId: "cam-1" });
  await canReply(viewer, true);
  viewer.send("controlReady", { deviceId: "cam-1" });
}

function canReplyUpdates(calls: SfuCall[]): Array<[string, boolean]> {
  return calls
    .filter((call) => call.path.endsWith("/datachannels/update"))
    .map((call) => [sessionOf(call), call.body.dataChannels[0].canReply]);
}

const controller = (room: string, viewerId: string) => ({ controller: { room, viewerId } });

describe("data channels", () => {
  test("a device that offers data channels gets _lossy and _reliable", async () => {
    const { calls, device } = await setup();
    const viewer = await dataViewer("v1");
    const { channels } = await publishWithData(device);
    expect(channels).toEqual({
      channels: [
        { label: "_lossy", id: 2 },
        { label: "_reliable", id: 4 },
      ],
    });
    const published = calls.find((call) => call.path.endsWith("/datachannels/new"))!;
    expect(sessionOf(published)).toBe(publisherSessions(calls)[0]);
    expect(published.body).toEqual({
      dataChannels: [
        { location: "local", ...LOSSY },
        { location: "local", ...RELIABLE },
      ],
    });
    expect(await viewer.device("cam-1", "live")).toMatchObject({ dataChannels: true });
  });

  test("a viewer with data_channels sends its own offer and opens a device's channels", async () => {
    const { calls, device } = await setup();
    const viewer = await dataViewer("v1");
    await publishWithData(device);
    expect(await openData(viewer)).toEqual({
      deviceId: "cam-1",
      generation: 1,
      channels: [
        { label: "_lossy", id: 1 },
        { label: "_reliable", id: 3 },
      ],
      canReply: false,
    });
    const establish = calls.find((call) => call.path.endsWith("/datachannels/establish"))!;
    expect(establish.body).toEqual({
      dataChannel: { location: "remote", dataChannelName: "server-events" },
      sessionDescription: { type: "offer", sdp: "v=0 viewer-offer" },
    });
    // The SFU answered the viewer's offer, so there is nothing to renegotiate.
    expect(calls.some((call) => call.path.endsWith("/renegotiate"))).toBe(false);
    const pulled = calls.filter((call) => call.path.endsWith("/datachannels/new")).at(-1)!;
    expect(sessionOf(pulled)).toBe(sessionOf(establish));
    const deviceSession = publisherSessions(calls)[0];
    expect(pulled.body.dataChannels).toEqual([
      { location: "remote", sessionId: deviceSession, canReply: false, ...LOSSY },
      { location: "remote", sessionId: deviceSession, canReply: false, ...RELIABLE },
    ]);
  });

  test("a viewer without data_channels can send its own offer, but cannot open channels or take control", async () => {
    const { calls, device } = await setup();
    const viewer = await earlyViewer("v1", "lab-a", false);
    await publishWithData(device);
    await viewer.device("cam-1", "live");

    // Its tracks come with the SFU's offer on the session its own offer set up.
    viewer.send("subscribe", { tracks: [{ deviceId: "cam-1", trackName: "video_track" }] });
    await viewer.next("offer");
    viewer.send("answer", { sdp: "v=0 viewer-answer" });
    expect((await viewer.next("subscribed")).tracks).toHaveLength(1);
    const establish = calls.find((call) => call.path.endsWith("/datachannels/establish"))!;
    const pulled = calls.filter((call) => call.path.endsWith("/tracks/new")).at(-1)!;
    expect(sessionOf(pulled)).toBe(sessionOf(establish));

    viewer.send("subscribe", { data: ["cam-1"] });
    expect(await viewer.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_DATA_CHANNELS_OFF, request: "subscribe" });
    viewer.send("takeControl", { deviceId: "cam-1" });
    expect(await viewer.next("error")).toMatchObject({
      code: ErrorCode.ERROR_CODE_DATA_CHANNELS_OFF,
      request: "take_control",
      deviceId: "cam-1",
    });
  });

  test("opening a device's channels needs the data transport first", async () => {
    const { device } = await setup();
    const viewer = await connect(await viewerToken("v1", "lab-a", true));
    await viewer.next("joined");
    await publishWithData(device);
    await viewer.device("cam-1", "live");
    viewer.send("subscribe", { data: ["cam-1"] });
    expect(await viewer.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_BUSY, request: "subscribe" });
  });

  test("taking control needs the device's channels open first", async () => {
    const { device } = await setup();
    const viewer = await dataViewer("v1");
    await publishWithData(device);
    await viewer.device("cam-1", "live");
    viewer.send("takeControl", { deviceId: "cam-1" });
    expect(await viewer.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_NO_DATA_CHANNELS, deviceId: "cam-1" });
  });
});

describe("control", () => {
  test("one viewer controls the device; releasing hands control to the next one waiting", async () => {
    const { calls, device } = await setup();
    const v1 = await dataViewer("v1");
    const v2 = await dataViewer("v2");
    await publishWithData(device);
    await openData(v1);
    await openData(v2);

    v1.send("takeControl", { deviceId: "cam-1" });
    await canReply(v1, true);
    // Handed over but not confirmed: nobody controls yet.
    expect(await info(v2, (device) => device.handover?.viewerId === "v1")).toMatchObject({ controller: undefined });
    v1.send("controlReady", { deviceId: "cam-1" });
    expect(await device.next("control")).toEqual(controller("lab-a", "v1"));
    await info(v2, (device) => device.controller?.viewerId === "v1" && !device.handover);

    v2.send("takeControl", { deviceId: "cam-1" });
    expect(await info(v1, (device) => device.waiting.length === 1)).toMatchObject({
      controller: { room: "lab-a", viewerId: "v1" },
      waiting: [{ room: "lab-a", viewerId: "v2" }],
    });

    v1.send("releaseControl", { deviceId: "cam-1" });
    await canReply(v1, false);
    await canReply(v2, true);
    expect(await device.next("control")).toEqual({ controller: undefined });
    v2.send("controlReady", { deviceId: "cam-1" });
    expect(await device.next("control")).toEqual(controller("lab-a", "v2"));

    const [v1Session, v2Session] = calls
      .filter((call) => call.path.endsWith("/datachannels/establish"))
      .map(sessionOf);
    expect(canReplyUpdates(calls)).toEqual([
      [v1Session, true],
      [v1Session, false],
      [v2Session, true],
    ]);
  });

  test("a handover that is not confirmed in time goes to the next one waiting", async () => {
    const { device } = await setup();
    const v1 = await dataViewer("v1");
    const v2 = await dataViewer("v2");
    await publishWithData(device);
    await openData(v1);
    await openData(v2);
    await control(v1);
    v2.send("takeControl", { deviceId: "cam-1" });
    await info(v1, (device) => device.waiting.length === 1);

    // v1 lets go and lines up again; v2 is handed control but never confirms.
    v1.send("releaseControl", { deviceId: "cam-1" });
    await canReply(v2, true);
    v1.send("takeControl", { deviceId: "cam-1" });
    await info(v1, (device) => device.handover?.viewerId === "v2" && device.waiting[0]?.viewerId === "v1");

    const stub = env.DEVICES.getByName("cam-1");
    await runInDurableObject(stub, async (_instance, state) => {
      const control = JSON.parse(state.storage.sql.exec<{ state: string }>("SELECT state FROM control").one().state);
      control.handover.deadline = Date.now() - 1;
      state.storage.sql.exec("UPDATE control SET state = ?", JSON.stringify(control));
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await v2.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_CONTROL_TIMEOUT, deviceId: "cam-1" });
    await canReply(v2, false);
    await canReply(v1, true);
    v1.send("controlReady", { deviceId: "cam-1" });
    await info(v2, (device) => device.controller?.viewerId === "v1" && device.waiting.length === 0);
  });

  test("a controller that leaves hands control to the next one waiting", async () => {
    const { device } = await setup();
    const v1 = await dataViewer("v1");
    const v2 = await dataViewer("v2");
    await publishWithData(device);
    await openData(v1);
    await openData(v2);
    await control(v1);
    v2.send("takeControl", { deviceId: "cam-1" });
    await info(v1, (device) => device.waiting.length === 1);

    v1.send("leave");
    await v1.closed();
    await canReply(v2, true);
    v2.send("controlReady", { deviceId: "cam-1" });
    await info(v2, (device) => device.controller?.viewerId === "v2");
  });

  test("closing the device's channels gives up control", async () => {
    const { calls, device } = await setup();
    const v1 = await dataViewer("v1");
    const v2 = await dataViewer("v2");
    await publishWithData(device);
    await openData(v1);
    await openData(v2);
    await control(v1);
    v2.send("takeControl", { deviceId: "cam-1" });
    await info(v1, (device) => device.waiting.length === 1);

    v1.send("unsubscribe", { data: ["cam-1"] });
    expect(await v1.next("subscribed")).toEqual({ tracks: [], data: [] });
    const closed = calls.find((call) => call.path.endsWith("/datachannels/close"))!;
    expect(closed.body).toEqual({ dataChannels: [{ id: 1 }, { id: 3 }] });
    await canReply(v2, true);
  });

  test("control is per device, so a viewer in another room waits in the same line", async () => {
    const { device } = await setup(["lab-a", "lab-b"]);
    const v1 = await dataViewer("v1", "lab-a");
    const w2 = await dataViewer("w2", "lab-b");
    await publishWithData(device);
    await openData(v1);
    await openData(w2);
    await control(v1);
    expect(await device.next("control")).toEqual(controller("lab-a", "v1"));

    w2.send("takeControl", { deviceId: "cam-1" });
    expect(await info(v1, (device) => device.waiting.length === 1)).toMatchObject({
      waiting: [{ room: "lab-b", viewerId: "w2" }],
    });
    v1.send("releaseControl", { deviceId: "cam-1" });
    await canReply(w2, true);
    w2.send("controlReady", { deviceId: "cam-1" });
    await info(v1, (device) => device.controller?.room === "lab-b" && device.controller?.viewerId === "w2");
  });

  test("control stays with the viewer when the device publishes again", async () => {
    const { calls, device } = await setup();
    const v1 = await dataViewer("v1");
    await publishWithData(device);
    await openData(v1);
    await control(v1);
    await device.next("control");

    // The device's PeerConnection failed, so it offers again.
    device.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS, dataChannels: true });
    expect(await device.next("answer")).toMatchObject({ generation: 2 });
    await device.next("channels");
    device.send("ready", {});
    await info(v1, (device) => device.generation === 2 && device.state === state_("live"));

    v1.send("subscribe", { data: ["cam-1"] });
    const subscribed = await v1.next("subscribed");
    expect(subscribed.data).toEqual([expect.objectContaining({ deviceId: "cam-1", generation: 2, canReply: true })]);
    const pulled = calls.filter((call) => call.path.endsWith("/datachannels/new")).at(-1)!;
    expect(pulled.body.dataChannels.map((channel: { canReply: boolean }) => channel.canReply)).toEqual([true, true]);
  });
});
