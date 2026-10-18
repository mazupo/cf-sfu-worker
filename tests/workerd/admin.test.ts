import { exports as workerExports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { connect, deviceToken, mockSfu, ORIGIN, PUBLISH_TRACKS, viewerToken } from "./helpers";

const ADMIN_KEY = "test-admin-key";

function admin(path: string, key?: string, origin = ORIGIN): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`${origin}/cloudflare/admin${path}`, { headers: key ? { Authorization: `Bearer ${key}` } : {} }),
  );
}

type Totals = { rooms: number; viewers: number; away: number; ipcViewers: number; devices: number; liveDevices: number };
type Listing = {
  host: string;
  appId: string;
  totals: Totals;
  rooms: { roomId: string; viewers: number; ipcViewers: number; devices: { deviceId: string; state: string | null }[] }[];
};

async function listing(): Promise<Listing> {
  const response = await admin("/rooms", ADMIN_KEY);
  expect(response.status).toBe(200);
  return response.json<Listing>();
}

/** Rooms report a moment after they change. */
async function eventually(check: (list: Listing) => boolean, timeoutMs = 3000): Promise<Listing> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await listing();
    if (check(list)) return list;
    if (Date.now() > deadline) throw new Error(`the dashboard never showed it: ${JSON.stringify(list)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("dashboard", () => {
  test("the admin API needs ADMIN_KEY, also on localhost", async () => {
    expect((await admin("/rooms")).status).toBe(401);
    expect((await admin("/rooms", "wrong")).status).toBe(401);
    expect((await admin("/rooms", ADMIN_KEY, "https://api.example.com")).status).toBe(200);
    expect((await admin("/rooms/lab-a")).status).toBe(401);
  });

  test("lists each room with its viewers and devices, a device in two rooms once", async () => {
    mockSfu();
    const cam = await connect(await deviceToken("cam-1", ["dash-a", "dash-b"]));
    await cam.next("joined");
    const viewer = await connect(await viewerToken("Alice", "dash-a", true));
    await viewer.next("joined");
    await cam.next("wake");
    cam.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS });
    await cam.next("answer");
    cam.send("ready", {});
    await viewer.device("cam-1", "live");

    const list = await eventually((list) => list.rooms.find((room) => room.roomId === "dash-a")?.devices[0]?.state === "live");
    expect(list.appId).toBe("test-app");
    expect(list.host).toBe("localhost");
    const roomA = list.rooms.find((room) => room.roomId === "dash-a")!;
    expect(roomA).toMatchObject({ viewers: 1, ipcViewers: 1, devices: [{ deviceId: "cam-1", state: "live" }] });
    // Nobody watches dash-b, so that room does not know the device's state.
    expect(list.rooms.find((room) => room.roomId === "dash-b")).toMatchObject({ viewers: 0, devices: [{ deviceId: "cam-1", state: null }] });
    expect(list.totals).toMatchObject({ rooms: 2, viewers: 1, ipcViewers: 1, devices: 1, liveDevices: 1 });

    const details = await admin("/rooms/dash-a", ADMIN_KEY);
    expect(details.status).toBe(200);
    const json = await details.json<{ room: { viewers: { viewerId: string }[] }; devices: { deviceId: string }[] }>();
    expect(json.room.viewers.map((viewer) => viewer.viewerId)).toEqual(["Alice"]);
    expect(json.devices.map((device) => device.deviceId)).toEqual(["cam-1"]);

    // A room without viewers or devices leaves the list.
    viewer.send("leave");
    await viewer.closed();
    cam.close();
    await eventually((list) => !list.rooms.some((room) => room.roomId.startsWith("dash-")));
  });
});
