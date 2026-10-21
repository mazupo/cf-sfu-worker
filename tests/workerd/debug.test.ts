import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { expect, test } from "vitest";

import worker from "../../src/worker";
import { DEVICE_PUBLIC_KEY, PUBLISH_TRACKS, VIEWER_PUBLIC_KEY, connect, deviceToken, mockSfu, viewerToken } from "./helpers";

const debug = (url: string, key?: string) =>
  workerExports.default.fetch(new Request(url, { headers: key ? { Authorization: `Bearer ${key}` } : {} }));

test("the debug view shows the room, its viewers and its devices", async () => {
  mockSfu();
  const device = await connect(await deviceToken("cam-1", ["lab-a"]));
  await device.next("joined");
  const viewer = await connect(await viewerToken("v1", "lab-a"));
  await viewer.next("joined");
  await device.next("wake");
  device.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
  await device.next("answer");
  device.send("ready", {});
  await viewer.device("cam-1", "live");

  const response = await debug("http://localhost/sfu/debug/rooms/lab-a");
  expect(response.status).toBe(200);
  const body = await response.json<any>();
  expect(body.room.members).toEqual([expect.objectContaining({ device_id: "cam-1" })]);
  expect(body.room.viewers).toEqual([
    expect.objectContaining({ viewerId: "v1", state: "joined", sockets: [expect.objectContaining({ readyState: 1 })] }),
  ]);
  expect(body.devices[0]).toMatchObject({
    deviceId: "cam-1",
    online: true,
    row: { state: "live", generation: 1, rooms: ["lab-a"] },
    watchingRooms: [expect.objectContaining({ room_id: "lab-a" })],
  });
  expect(body.devices[0].alarm).toBeGreaterThan(Date.now());

  const single = await debug("http://localhost/sfu/debug/devices/cam-1");
  expect((await single.json<any>()).device.row.state).toBe("live");
  viewer.close();
  device.close();
});

test("the debug view is off on other hosts unless DEBUG_STATE is true", async () => {
  expect((await debug("https://cf-sfu.example.com/sfu/debug/rooms/lab-a", VIEWER_PUBLIC_KEY)).status).toBe(404);
});

test("with DEBUG_STATE on another host, the debug view needs a public key", async () => {
  const onHost = async (key?: string) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://cf-sfu.example.com/sfu/debug/devices/cam-1", { headers: key ? { Authorization: `Bearer ${key}` } : {} }),
      { ...env, DEBUG_STATE: "true" },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response.status;
  };
  expect(await onHost()).toBe(401);
  expect(await onHost("wrong")).toBe(401);
  expect(await onHost(DEVICE_PUBLIC_KEY)).toBe(200);
  expect(await onHost(VIEWER_PUBLIC_KEY)).toBe(200);
});
