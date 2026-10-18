import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import {
  connect,
  deviceToken,
  mockSfu,
  PUBLISH_TRACKS,
  state_,
  type TestSocket,
  viewerToken,
} from "./helpers";

async function liveDevice(deviceId: string, room: string) {
  mockSfu();
  const device = await connect(await deviceToken(deviceId, [room]));
  await device.next("joined");
  const viewer = await connect(await viewerToken("v1", room));
  await viewer.next("joined");
  await device.next("wake");
  device.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
  await device.next("answer");
  device.send("ready", {});
  await viewer.device(deviceId, "live");
  return { device, viewer };
}

/** Pretends the device's last sign of life was `ms` ago: stale (45 s) but not gone (60 s) by default. */
async function silence(deviceId: string, ms = 50_000) {
  await runInDurableObject(env.DEVICES.getByName(deviceId), (_instance, state) => {
    for (const ws of state.getWebSockets()) ws.serializeAttachment({ connectedAt: Date.now() - ms });
  });
}

/** Moves the device's disconnect time `ms` into the past. */
async function disconnectedAgo(deviceId: string, ms: number) {
  await runInDurableObject(env.DEVICES.getByName(deviceId), (_instance, state) => {
    state.storage.sql.exec("UPDATE device SET disconnected_at = ?", Date.now() - ms);
  });
}

function alarmOf(deviceId: string) {
  return runInDurableObject(env.DEVICES.getByName(deviceId), (_instance, state) => state.storage.getAlarm());
}

/** An empty room deletes its storage, tables included. */
function members(roomId: string) {
  return runInDurableObject(env.ROOMS.getByName(roomId), (_instance, state) => {
    const sql = state.storage.sql;
    if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'members'").toArray().length === 0) return 0;
    return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members").one().n;
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
    // The grace time counts from the last ping, so the room hears it in the same check.
    expect(await viewer.device("cam-1", "offline")).toMatchObject({ tracks: [] });
    viewer.close();
  });

  test("while watched, the heartbeat is checked when the last ping turns stale", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a");
    const { alarm, lastSeen } = await runInDurableObject(env.DEVICES.getByName("cam-1"), async (_instance, state) => {
      const ws = state.getWebSockets()[0]!;
      const pong = state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const { connectedAt } = ws.deserializeAttachment() as { connectedAt: number };
      return { alarm: await state.storage.getAlarm(), lastSeen: Math.max(pong, connectedAt) };
    });
    // DEVICE_STALE_SECONDS is 45 in the test config.
    expect(alarm).toBe(lastSeen + 46_000);
    for (const socket of [viewer, device]) socket.close();
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

  test("a device that drops its socket shows offline, and leaves its rooms after a minute", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a");
    const stub = env.DEVICES.getByName("cam-1");
    // Not 1000 or 1001: the process died, e.g. Ctrl+C without a close.
    device.ws.close(4100, "killed");
    await expect
      .poll(() => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT disconnected_at FROM device").one().disconnected_at))
      .not.toBeNull();
    await disconnectedAgo("cam-1", 30_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await viewer.device("cam-1", "offline")).toMatchObject({ tracks: [] });
    const { alarm, disconnectedAt } = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      disconnectedAt: state.storage.sql.exec<{ at: number }>("SELECT disconnected_at AS at FROM device").one().at,
    }));
    expect(alarm).toBe(disconnectedAt + 60_000);

    await disconnectedAgo("cam-1", 61_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await viewer.next("members")).devices).toEqual([]);

    // It joins its rooms again when it comes back.
    const back = await connect(await deviceToken("cam-1", ["lab-a"]));
    expect(await back.next("joined")).toMatchObject({ rooms: ["lab-a"] });
    expect((await viewer.next("members")).devices).toEqual([expect.objectContaining({ deviceId: "cam-1" })]);
    for (const socket of [viewer, back]) socket.close();
  });

  test("a device nobody watches checks its socket every 5 minutes, and leaves its rooms when it is gone", async () => {
    mockSfu();
    const device = await connect(await deviceToken("cam-1", ["lab-a"]));
    await device.next("joined");
    const stub = env.DEVICES.getByName("cam-1");
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + 4 * 60_000);

    await silence("cam-1", 61_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await device.closed()).code).toBe(4001);
    expect(await members("lab-a")).toBe(0);
  });

  test("a device whose socket went away without a close, as on a restart, still leaves its rooms", async () => {
    mockSfu();
    const device = await connect(await deviceToken("cam-1", ["lab-a"]));
    await device.next("joined");
    device.ws.close(4100, "killed");
    const stub = env.DEVICES.getByName("cam-1");
    await expect.poll(() => alarmOf("cam-1")).not.toBeNull();
    // As after a restart: nothing set the disconnect time and no alarm is pending.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE device SET disconnected_at = NULL, offline_notified = 0");
      await state.storage.deleteAlarm();
    });
    await expect(runInDurableObject(stub, (_instance, state) => state.abort("restart"))).rejects.toThrow();

    // The next request starts a new instance, which schedules the checks itself.
    expect(await alarmOf("cam-1")).not.toBeNull();
    await disconnectedAgo("cam-1", 61_000);
    expect(await runDurableObjectAlarm(env.DEVICES.getByName("cam-1"))).toBe(true);
    expect(await members("lab-a")).toBe(0);
  });

  test("a device that stops pinging for a minute leaves its rooms", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a");
    await silence("cam-1", 61_000);
    expect(await runDurableObjectAlarm(env.DEVICES.getByName("cam-1"))).toBe(true);
    expect((await device.closed()).code).toBe(4001);
    expect((await viewer.next("members")).devices).toEqual([]);
    viewer.close();
  });

  test("a new viewer sees the same state as the viewers already there", async () => {
    const { device, viewer } = await liveDevice("cam-1", "lab-a");
    const second: TestSocket = await connect(await viewerToken("v2", "lab-a"));
    expect((await second.next("joined")).devices).toEqual([expect.objectContaining({ deviceId: "cam-1", state: state_("live") })]);
    for (const socket of [viewer, second, device]) socket.close();
  });
});
