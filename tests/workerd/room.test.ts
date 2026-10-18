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
  viewerToken,
} from "./helpers";

async function publish(device: Awaited<ReturnType<typeof connect>>) {
  await device.next("wake");
  device.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
  await device.next("answer");
  device.send("ready", {});
}

describe("rooms", () => {
  test("one viewer wakes every device in the room and pulls them on one session", async () => {
    const calls = mockSfu();
    const cam1 = await connect(await deviceToken("cam-1", ["lab-a"]));
    const cam2 = await connect(await deviceToken("cam-2", ["lab-a"]));
    await cam1.next("joined");
    await cam2.next("joined");

    const viewer = await connect(await viewerToken("v1", "lab-a"));
    const joined = await viewer.next("joined");
    expect(joined.devices.map((device: { deviceId: string }) => device.deviceId)).toEqual(["cam-1", "cam-2"]);

    await publish(cam1);
    await publish(cam2);
    await viewer.device("cam-1", "live");
    await viewer.device("cam-2", "live");

    viewer.send("subscribe", {
      tracks: [
        { deviceId: "cam-1", trackName: "video_track" },
        { deviceId: "cam-2", trackName: "video_track" },
      ],
    });
    const offer = await viewer.next("offer");
    expect(offer.tracks.map((track: { deviceId: string }) => track.deviceId).sort()).toEqual(["cam-1", "cam-2"]);
    viewer.send("answer", { sdp: "v=0 viewer-answer" });
    await viewer.next("subscribed");

    // Both devices' tracks came through a single tracks/new call on the viewer's session.
    const pulls = calls.filter((call) => call.path.endsWith("/tracks/new") && call.body.tracks[0].location === "remote");
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.body.tracks.map((track: { sessionId: string }) => track.sessionId)).toEqual(publisherSessions(calls));
    expect(calls.filter((call) => call.path.endsWith("/sessions/new"))).toHaveLength(3);
    for (const socket of [viewer, cam1, cam2]) socket.close();
  });

  test("viewers see devices join and leave the room", async () => {
    mockSfu();
    const viewer = await connect(await viewerToken("v1", "lab-a"));
    expect((await viewer.next("joined")).devices).toEqual([]);

    const cam1 = await connect(await deviceToken("cam-1", ["lab-a"]));
    expect((await viewer.next("members")).devices).toEqual([expect.objectContaining({ deviceId: "cam-1" })]);
    // The room was already watching, so the new device is woken right away.
    await cam1.next("wake");
    await viewer.device("cam-1", "waking");

    // The device restarts in a different room.
    cam1.close();
    const moved = await connect(await deviceToken("cam-1", ["lab-b"]));
    await moved.next("joined");
    expect((await viewer.next("members")).devices).toEqual([]);
    for (const socket of [viewer, moved]) socket.close();
  });

  test("a room holds up to MAX_DEVICES_PER_ROOM devices", async () => {
    const sockets = [];
    for (const id of ["cam-1", "cam-2", "cam-3"]) {
      const socket = await connect(await deviceToken(id, ["lab-a"]));
      expect((await socket.next("joined")).rooms).toEqual(["lab-a"]);
      sockets.push(socket);
    }
    const fourth = await connect(await deviceToken("cam-4", ["lab-a", "lab-b"]));
    expect((await fourth.next("joined")).rooms).toEqual(["lab-b"]);
    expect(await fourth.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_ROOM_FULL });
    for (const socket of [...sockets, fourth]) socket.close();
  });

  test("unsubscribing closes the tracks and renegotiates", async () => {
    const calls = mockSfu();
    const cam1 = await connect(await deviceToken("cam-1", ["lab-a"]));
    await cam1.next("joined");
    const viewer = await connect(await viewerToken("v1", "lab-a"));
    await viewer.next("joined");
    await publish(cam1);
    await viewer.device("cam-1", "live");

    viewer.send("subscribe", {
      tracks: [
        { deviceId: "cam-1", trackName: "video_track" },
        { deviceId: "cam-1", trackName: "audio_track" },
      ],
    });
    const { tracks } = await viewer.next("offer");
    viewer.send("answer", { sdp: "v=0 viewer-answer" });
    await viewer.next("subscribed");

    const audio = tracks.find((track: { trackName: string }) => track.trackName === "audio_track");
    viewer.send("unsubscribe", { mids: [audio.mid] });
    const offer = await viewer.next("offer");
    expect(offer.tracks).toEqual([expect.objectContaining({ trackName: "video_track" })]);
    viewer.send("answer", { sdp: "v=0 viewer-answer-2" });
    expect((await viewer.next("subscribed")).tracks).toHaveLength(1);
    expect(calls.find((call) => call.path.endsWith("/tracks/close"))!.body).toEqual({ force: true, tracks: [{ mid: audio.mid }] });
    for (const socket of [viewer, cam1]) socket.close();
  });

  test("a track the SFU cannot find yet is reported, and the other tracks still subscribe", async () => {
    mockSfu({ missingTrack: "audio_track" });
    const cam1 = await connect(await deviceToken("cam-1", ["lab-a"]));
    await cam1.next("joined");
    const viewer = await connect(await viewerToken("v1", "lab-a"));
    await viewer.next("joined");
    await publish(cam1);
    await viewer.device("cam-1", "live");

    viewer.send("subscribe", {
      tracks: [
        { deviceId: "cam-1", trackName: "video_track" },
        { deviceId: "cam-1", trackName: "audio_track" },
      ],
    });
    expect(await viewer.next("error")).toMatchObject({
      code: ErrorCode.ERROR_CODE_TRACK_NOT_READY,
      message: expect.stringContaining("not_found_track_error"),
      deviceId: "cam-1",
      trackName: "audio_track",
      retryable: true,
    });
    const offer = await viewer.next("offer");
    expect(offer.tracks).toEqual([expect.objectContaining({ trackName: "video_track" })]);
    viewer.send("answer", { sdp: "v=0 viewer-answer" });
    expect((await viewer.next("subscribed")).tracks).toHaveLength(1);
    for (const socket of [viewer, cam1]) socket.close();
  });

  test("a device is not live until it sends ready", async () => {
    mockSfu();
    const cam1 = await connect(await deviceToken("cam-1", ["lab-a"]));
    await cam1.next("joined");
    const viewer = await connect(await viewerToken("v1", "lab-a"));
    await viewer.next("joined");
    await cam1.next("wake");
    cam1.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
    await cam1.next("answer");
    await viewer.device("cam-1", "waking");

    viewer.send("subscribe", { tracks: [{ deviceId: "cam-1", trackName: "video_track" }] });
    expect(await viewer.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_NOT_LIVE, deviceId: "cam-1", retryable: true });
    await viewer.next("subscribed");

    cam1.send("ready", {});
    await viewer.device("cam-1", "live");
    for (const socket of [viewer, cam1]) socket.close();
  });

  test("a subscribe while an offer is waiting is refused", async () => {
    mockSfu();
    const cam1 = await connect(await deviceToken("cam-1", ["lab-a"]));
    await cam1.next("joined");
    const viewer = await connect(await viewerToken("v1", "lab-a"));
    await viewer.next("joined");
    await publish(cam1);
    await viewer.device("cam-1", "live");

    viewer.send("subscribe", { tracks: [{ deviceId: "cam-1", trackName: "video_track" }] });
    await viewer.next("offer");
    viewer.send("subscribe", { tracks: [{ deviceId: "cam-1", trackName: "audio_track" }] });
    expect(await viewer.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_BUSY, request: "subscribe" });
    for (const socket of [viewer, cam1]) socket.close();
  });

  test("a device whose connection drops shows as offline after the grace period", async () => {
    mockSfu();
    const cam1 = await connect(await deviceToken("cam-1", ["lab-a"]));
    await cam1.next("joined");
    const viewer = await connect(await viewerToken("v1", "lab-a"));
    await viewer.next("joined");
    await publish(cam1);
    await viewer.device("cam-1", "live");

    // A dropped connection, not a goodbye: 1000 and 1001 would make the device leave the room.
    cam1.ws.close(3000, "network lost");
    const stub = env.DEVICES.getByName("cam-1");
    // Wait for the Device DO to see the close, then skip the grace period.
    await expect
      .poll(() => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT disconnected_at FROM device").one().disconnected_at))
      .not.toBeNull();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE device SET disconnected_at = ?", Date.now() - 30_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await viewer.device("cam-1", "offline")).toMatchObject({ tracks: [] });
    viewer.close();
  });

  test("viewers see who else watches the room", async () => {
    const alice = await connect(await viewerToken("Alice", "lab-viewers"));
    expect((await alice.next("joined")).viewers).toEqual([{ viewerId: "Alice", dataChannels: false, away: false }]);

    const bob = await connect(await viewerToken("Bob Lee", "lab-viewers", true));
    const bobJoined = await bob.next("joined");
    expect(bobJoined.viewers.map((viewer: { viewerId: string }) => viewer.viewerId)).toEqual(["Alice", "Bob Lee"]);
    expect(await alice.next("viewers")).toEqual({
      viewers: [
        { viewerId: "Alice", dataChannels: false, away: false },
        { viewerId: "Bob Lee", dataChannels: true, away: false },
      ],
    });
    // Its joined has the list already.
    expect(bob.has("viewers")).toBe(false);

    const carol = await connect(await viewerToken("carol", "lab-viewers"));
    await carol.next("joined");
    expect((await alice.next("viewers")).viewers).toHaveLength(3);

    // A dropped socket may come back, so it stays in the list as away.
    bob.close();
    expect((await alice.next("viewers")).viewers[1]).toEqual({ viewerId: "Bob Lee", dataChannels: true, away: true });

    carol.send("leave");
    await carol.closed();
    expect((await alice.next("viewers")).viewers.map((viewer: { viewerId: string }) => viewer.viewerId)).toEqual(["Alice", "Bob Lee"]);
    alice.close();
  });
});
