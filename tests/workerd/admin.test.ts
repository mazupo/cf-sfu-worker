import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, test } from "vitest";

import worker from "../../src/worker";
import { connect, deviceToken, mockSfu, ORIGIN, PUBLISH_TRACKS, viewerToken } from "./helpers";
import { network } from "./network";

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

describe("dashboard behind Cloudflare Access", () => {
  const TEAM = "https://test-team.cloudflareaccess.com";
  const AUD = "test-access-aud";
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwk: Record<string, unknown>;

  beforeAll(async () => {
    keys = await generateKeyPair("RS256", { extractable: true });
    jwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  });

  /** What Access puts in Cf-Access-Jwt-Assertion, with the parts a test wants to get wrong. */
  function accessJwt(options: { audience?: string; issuer?: string; expiresIn?: string; key?: CryptoKey } = {}) {
    return new SignJWT({ email: "richard@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(options.issuer ?? TEAM)
      .setAudience([options.audience ?? AUD])
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? "10m")
      .sign(options.key ?? keys.privateKey);
  }

  /** The worker with Access turned on. The team domain is given without https://, as people often do. */
  async function viaAccess(path: string, headers: Record<string, string> = {}): Promise<Response> {
    network.use(http.get(`${TEAM}/cdn-cgi/access/certs`, () => HttpResponse.json({ keys: [jwk] })));
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/cloudflare/admin${path}`, { headers }),
      { ...env, ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com/", ACCESS_AUD: AUD },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  test("a request Access let in reads the dashboard and learns who signed in", async () => {
    const response = await viaAccess("/rooms", { "Cf-Access-Jwt-Assertion": await accessJwt() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ auth: { mode: "access", email: "richard@example.com" } });
    expect((await viaAccess("/rooms/lab-a", { "Cf-Access-Jwt-Assertion": await accessJwt() })).status).toBe(200);
  });

  test("without a valid Access JWT it is refused, even on localhost and with ADMIN_KEY", async () => {
    const refused = async (headers: Record<string, string>) => {
      const response = await viaAccess("/rooms", headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "access_required" } });
    };
    await refused({});
    await refused({ Authorization: `Bearer ${ADMIN_KEY}` });
    await refused({ "Cf-Access-Jwt-Assertion": await accessJwt({ audience: "another-app" }) });
    await refused({ "Cf-Access-Jwt-Assertion": await accessJwt({ issuer: "https://another-team.cloudflareaccess.com" }) });
    await refused({ "Cf-Access-Jwt-Assertion": await accessJwt({ expiresIn: "-1m" }) });
    const stranger = await generateKeyPair("RS256");
    await refused({ "Cf-Access-Jwt-Assertion": await accessJwt({ key: stranger.privateKey }) });
    await refused({ "Cf-Access-Jwt-Assertion": "not-a-jwt" });
  });

  test("without Access, the listing says how it was opened", async () => {
    expect(await (await admin("/rooms", ADMIN_KEY)).json()).toMatchObject({ auth: { mode: "key" } });
  });
});
