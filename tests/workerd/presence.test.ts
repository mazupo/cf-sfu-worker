import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { PUBLISH_TRACKS, connect, deviceToken, mockSfu, viewerToken, type TestSocket } from "./helpers";

async function liveDevice(deviceId: string, room: string) {
  mockSfu();
  const device = await connect(await deviceToken(deviceId, [room]));
  await device.next("joined");
  const viewer = await connect(await viewerToken("v1", room));
  await viewer.next("joined");
  const { wakeId } = await device.next("wake");
  device.send("offer", { wakeId, sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
  await device.next("answer");
  device.send("ready", { wakeId });
  await viewer.device(deviceId, "live");
  return { device, viewer };
}

/** Pretends the device's last sign of life was a minute ago. */
async function silence(deviceId: string) {
  await runInDurableObject(env.DEVICES.getByName(deviceId), (_instance, state) => {
    for (const ws of state.getWebSockets()) ws.serializeAttachment({ connectedAt: Date.now() - 60_000 });
  });
}

describe("presence", () => {
  test("ping keeps the device online, and is answered without a message to the DO", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a");
    device.sendText("ping");
    expect(await device.nextText()).toBe("pong");
    const seen = await runInDurableObject(env.DEVICES.getByName("cam-1"), (_instance, state) =>
      state.getWebSocketAutoResponseTimestamp(state.getWebSockets()[0]!)?.getTime(),
    );
    expect(Date.now() - seen!).toBeLessThan(5000);
    for (const socket of [viewer, device]) socket.close();
  });

  test("a device that stops pinging is closed with 4001 and shows as offline", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a");
    await silence("cam-1");
    const stub = env.DEVICES.getByName("cam-1");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await device.closed()).code).toBe(4001);

    // After the grace period, the room hears that the device is offline.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE device SET disconnected_at = ?", Date.now() - 60_000);
    });
    await runDurableObjectAlarm(stub);
    expect(await viewer.device("cam-1", "offline")).toMatchObject({ tracks: [] });
    viewer.close();
  });

  test("a room renewing its watch tells viewers when a device changed", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a");
    await silence("cam-1");
    // The room renews its lease and learns the device is offline. Viewers must hear it too.
    await runInDurableObject(env.ROOMS.getByName("lab-a"), (_instance, state) => {
      state.storage.sql.exec("UPDATE devices SET lease_renewed_at = 0");
    });
    await runDurableObjectAlarm(env.ROOMS.getByName("lab-a"));
    expect(await viewer.device("cam-1", "offline")).toMatchObject({ deviceId: "cam-1" });
    for (const socket of [viewer, device]) socket.close();
  });

  test("a device that closes its socket normally leaves its rooms", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a");
    device.ws.close(1000, "bye");
    expect((await viewer.next("members")).devices).toEqual([]);
    viewer.close();
  });

  test("a new viewer sees the same state as the viewers already there", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a");
    const second: TestSocket = await connect(await viewerToken("v2", "lab-a"));
    expect((await second.next("joined")).devices).toEqual([expect.objectContaining({ deviceId: "cam-1", state: "live" })]);
    for (const socket of [viewer, second, device]) socket.close();
  });
});
