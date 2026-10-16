import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { PUBLISH_TRACKS, connect, deviceToken, mockSfu, viewerToken } from "./helpers";

async function publish(device: Awaited<ReturnType<typeof connect>>) {
  const { wakeId } = await device.next("wake");
  device.send("offer", { wakeId, sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
  await device.next("answer");
  device.send("ready", { wakeId });
  return wakeId as string;
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
    expect(pulls[0]!.body.tracks.map((track: { sessionId: string }) => track.sessionId)).toEqual(["session-1", "session-2"]);
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
    expect(await fourth.next("error")).toMatchObject({ code: "room_full" });
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
      code: "not_found_track_error",
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
    const { wakeId } = await cam1.next("wake");
    cam1.send("offer", { wakeId, sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
    await cam1.next("answer");
    await viewer.device("cam-1", "waking");

    viewer.send("subscribe", { tracks: [{ deviceId: "cam-1", trackName: "video_track" }] });
    expect(await viewer.next("error")).toMatchObject({ code: "not_live", deviceId: "cam-1", retryable: true });
    await viewer.next("subscribed");

    cam1.send("ready", { wakeId });
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
    expect(await viewer.next("error")).toMatchObject({ code: "busy", action: "subscribe" });
    for (const socket of [viewer, cam1]) socket.close();
  });

  test("a device whose socket closes shows as offline after the grace period", async () => {
    mockSfu();
    const cam1 = await connect(await deviceToken("cam-1", ["lab-a"]));
    await cam1.next("joined");
    const viewer = await connect(await viewerToken("v1", "lab-a"));
    await viewer.next("joined");
    await publish(cam1);
    await viewer.device("cam-1", "live");

    cam1.close();
    const stub = env.DEVICES.getByName("cam-1");
    // Wait for the Device DO to see the close, then skip the grace period.
    await expect
      .poll(() => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT disconnected_at FROM device").one().disconnected_at))
      .not.toBeNull();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE device SET disconnected_at = ?", Date.now() - 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await viewer.device("cam-1", "offline")).toMatchObject({ tracks: [] });
    viewer.close();
  });
});
