import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";

import { ErrorCode } from "../../src/proto/cloudflare";
import {
  connect,
  deviceToken,
  mockSfu,
  PUBLISH_TRACKS,
  sessionOf,
  type SfuCall,
  type TestSocket,
  viewerToken,
} from "./helpers";

const ROOM = "voice";

/** Joins and has its own offer answered, so its session can carry a microphone. */
async function viewer(viewerId: string, room = ROOM): Promise<TestSocket> {
  const ws = await connect(await viewerToken(viewerId, room));
  await ws.next("joined");
  ws.send("offer", { sdp: `v=0 ${viewerId}-offer` });
  await ws.next("answer");
  return ws;
}

function publishMicrophone(ws: TestSocket, viewerId: string, muted = true) {
  ws.send("mute", { muted });
  ws.send("offer", { sdp: `v=0 ${viewerId}-microphone-offer`, tracks: [{ trackName: "microphone", mid: "1" }] });
}

/** The viewers list a socket hears next, by id. */
async function viewersOf(ws: TestSocket) {
  const { viewers } = await ws.next("viewers");
  return Object.fromEntries(viewers.map((info: { viewerId: string }) => [info.viewerId, info]));
}

/** The session the worker gave a viewer: the one its own offer went to. */
function sessionOfOffer(calls: SfuCall[], viewerId: string): string {
  const call = calls.find((c) => c.path.endsWith("/datachannels/establish") && c.body.sessionDescription.sdp === `v=0 ${viewerId}-offer`);
  return sessionOf(call!);
}

describe("voice", () => {
  test("a viewer publishes its microphone on its own session, and everyone sees it", async () => {
    const calls = mockSfu();
    const alice = await viewer("Alice");
    const bob = await viewer("Bob");
    await alice.next("viewers"); // Bob joined

    publishMicrophone(alice, "Alice");
    expect(await alice.next("answer")).toEqual({ sdp: "v=0 publisher-answer" });
    const push = calls.find((call) => call.path.endsWith("/tracks/new"))!;
    expect(sessionOf(push)).toBe(sessionOfOffer(calls, "Alice"));
    expect(push.body).toEqual({
      sessionDescription: { type: "offer", sdp: "v=0 Alice-microphone-offer" },
      tracks: [{ location: "local", mid: "1", trackName: "microphone" }],
    });
    expect((await viewersOf(bob)).Alice).toMatchObject({ microphone: true, muted: true, microphoneGeneration: 1 });
    expect((await viewersOf(alice)).Bob).toMatchObject({ microphone: false });

    alice.send("mute", { muted: false });
    expect((await viewersOf(bob)).Alice).toMatchObject({ microphone: true, muted: false });
    for (const ws of [alice, bob]) ws.close();
  });

  test("others pull a microphone from the speaker's session", async () => {
    const calls = mockSfu();
    const alice = await viewer("Alice");
    const bob = await viewer("Bob");
    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    await bob.next("viewers");

    bob.send("subscribe", { microphones: ["Alice"] });
    const offer = await bob.next("offer");
    expect(offer.tracks).toEqual([{ deviceId: "", viewerId: "Alice", trackName: "microphone", mid: "100", generation: 1, room: "" }]);
    const pull = calls.filter((call) => call.path.endsWith("/tracks/new")).at(-1)!;
    expect(sessionOf(pull)).toBe(sessionOfOffer(calls, "Bob"));
    expect(pull.body.tracks).toEqual([{ location: "remote", sessionId: sessionOfOffer(calls, "Alice"), trackName: "microphone" }]);
    bob.send("answer", { sdp: "v=0 bob-answer" });
    expect((await bob.next("subscribed")).tracks).toEqual(offer.tracks);

    // Asking again for the same publication pulls nothing more.
    const before = calls.length;
    bob.send("subscribe", { microphones: ["Alice"] });
    await bob.next("subscribed");
    expect(calls.length).toBe(before);

    // Nobody pulls their own microphone, or one that is not there.
    alice.send("subscribe", { microphones: ["Alice", "Bob"] });
    const errors = [await alice.next("error"), await alice.next("error")];
    expect(errors.map((error) => [error.viewerId, error.code])).toEqual([
      ["Alice", ErrorCode.ERROR_CODE_TRACK_NOT_FOUND],
      ["Bob", ErrorCode.ERROR_CODE_TRACK_NOT_FOUND],
    ]);

    // Unsubscribing a microphone closes it at the SFU like any track.
    bob.send("unsubscribe", { mids: ["100"] });
    await bob.next("offer");
    expect(calls.at(-1)!.path).toBe(`/v1/apps/test-app/sessions/${sessionOfOffer(calls, "Bob")}/tracks/close`);
    for (const ws of [alice, bob]) ws.close();
  });

  test("a microphone needs the viewer's own offer first, and one per PeerConnection", async () => {
    mockSfu();
    const early = await connect(await viewerToken("Early", ROOM));
    await early.next("joined");
    publishMicrophone(early, "Early");
    expect(await early.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_BUSY, request: "offer", trackName: "microphone" });

    const alice = await viewer("Alice");
    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    publishMicrophone(alice, "Alice");
    expect(await alice.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_BUSY, request: "offer", trackName: "microphone" });
    for (const ws of [early, alice]) ws.close();
  });

  test("a room takes MAX_MICROPHONES_PER_ROOM microphones; the next viewer listens", async () => {
    mockSfu();
    // MAX_MICROPHONES_PER_ROOM is 2 in the test config.
    const speakers = [await viewer("Alice"), await viewer("Bob")];
    for (const [index, ws] of speakers.entries()) {
      publishMicrophone(ws, ["Alice", "Bob"][index]!);
      await ws.next("answer");
    }
    const carol = await viewer("Carol");
    publishMicrophone(carol, "Carol");
    expect(await carol.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_MICROPHONE_LIMIT, request: "offer", trackName: "microphone" });
    carol.send("subscribe", { microphones: ["Alice", "Bob"] });
    expect((await carol.next("offer")).tracks.map((t: { viewerId: string }) => t.viewerId)).toEqual(["Alice", "Bob"]);
    for (const ws of [...speakers, carol]) ws.close();
  });

  test("microphones offered at the same time still stop at the limit", async () => {
    mockSfu({ microphoneDelayMs: 200 });
    const alice = await viewer("Alice");
    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    // One place is left, and the SFU is slow: both offers are waiting at once.
    const bob = await viewer("Bob");
    const carol = await viewer("Carol");
    publishMicrophone(bob, "Bob");
    publishMicrophone(carol, "Carol");
    const outcome = async (ws: TestSocket) => {
      await vi.waitFor(() => expect(ws.has("answer") || ws.has("error")).toBe(true), { timeout: 3000 });
      return ws.has("answer") ? "answer" : (await ws.next("error")).code;
    };
    expect([await outcome(bob), await outcome(carol)].sort()).toEqual(["answer", ErrorCode.ERROR_CODE_MICROPHONE_LIMIT].sort());
    for (const ws of [alice, bob, carol]) ws.close();
  });

  test("a new PeerConnection drops the microphone until it publishes again", async () => {
    mockSfu();
    const alice = await viewer("Alice");
    const bob = await viewer("Bob");
    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    expect((await viewersOf(bob)).Alice).toMatchObject({ microphone: true, microphoneGeneration: 1 });

    alice.send("offer", { sdp: "v=0 Alice-offer-2" });
    await alice.next("answer");
    expect((await viewersOf(bob)).Alice).toMatchObject({ microphone: false, microphoneGeneration: 1 });
    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    expect((await viewersOf(bob)).Alice).toMatchObject({ microphone: true, microphoneGeneration: 2 });
    for (const ws of [alice, bob]) ws.close();
  });

  test("when a speaker leaves, others' pulls of its microphone never match its next one", async () => {
    mockSfu();
    const alice = await viewer("Alice");
    const bob = await viewer("Bob");
    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    bob.send("subscribe", { microphones: ["Alice"] });
    await bob.next("offer");
    bob.send("answer", { sdp: "v=0 bob-answer" });
    await bob.next("subscribed");

    alice.send("leave");
    await alice.closed();
    const generation = () =>
      runInDurableObject(env.ROOMS.getByName(ROOM), (_instance, state) =>
        state.storage.sql.exec<{ generation: number }>("SELECT generation FROM subscriptions WHERE mic_of = 'Alice'").one().generation,
      );
    expect(await generation()).toBe(0);
    bob.close();
  });

  test("a room made before microphones gets the new columns", async () => {
    mockSfu();
    const stub = env.ROOMS.getByName(ROOM);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TABLE members (device_id TEXT PRIMARY KEY, joined_at INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE devices (device_id TEXT PRIMARY KEY, info TEXT NOT NULL, lease_renewed_at INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE viewers (viewer_id TEXT PRIMARY KEY, sfu_session_id TEXT, negotiating INTEGER NOT NULL,
          pending_offer TEXT, created_at INTEGER NOT NULL, socket_closed_at INTEGER, data_channels INTEGER NOT NULL,
          data_transport INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE subscriptions (viewer_id TEXT NOT NULL, mid TEXT NOT NULL, device_id TEXT NOT NULL,
          track_name TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY (viewer_id, mid)) WITHOUT ROWID;
        CREATE TABLE data_subscriptions (viewer_id TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL,
          device_session TEXT NOT NULL, channels TEXT NOT NULL, can_reply INTEGER NOT NULL,
          PRIMARY KEY (viewer_id, device_id)) WITHOUT ROWID;
        CREATE TABLE used_tokens (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID;
      `);
    });
    await expect(runInDurableObject(stub, (_instance, state) => state.abort("deploy"))).rejects.toThrow();

    const alice = await viewer("Alice");
    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    expect((await viewersOf(alice)).Alice).toMatchObject({ microphone: true, microphoneGeneration: 1 });
    alice.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Devices play the viewers' voices
// ---------------------------------------------------------------------------------------------

const CAM = "cam-voice";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A device in `rooms`, connected and sleeping. */
async function device(rooms: string[] = [ROOM]): Promise<TestSocket> {
  const ws = await connect(await deviceToken(CAM, rooms));
  await ws.next("joined");
  return ws;
}

/** Answers the wake with an offer, with voices or without, and says its PeerConnection is connected. */
async function publish(ws: TestSocket, voices = true): Promise<void> {
  await ws.next("wake");
  ws.send("offer", { sdp: "v=0 publisher-offer", tracks: PUBLISH_TRACKS, voices });
  await ws.next("answer");
  ws.send("ready", {});
}

/** The session the device published on. */
function deviceSession(calls: SfuCall[]): string {
  return sessionOf(calls.find((call) => call.body?.sessionDescription?.sdp === "v=0 publisher-offer")!);
}

/** The microphones pulled into the device's session. */
function devicePulls(calls: SfuCall[]): SfuCall[] {
  const session = deviceSession(calls);
  return calls.filter((call) => call.path.endsWith(`/sessions/${session}/tracks/new`) && call.body.tracks[0].location === "remote");
}

/** Waits for a call, e.g. the device's renegotiate, which follows its answer. */
async function callMatching(calls: SfuCall[], match: (call: SfuCall) => boolean): Promise<SfuCall> {
  for (let tries = 0; tries < 100; tries++) {
    const found = calls.find(match);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(`No such SFU call in ${JSON.stringify(calls.map((call) => call.path))}`);
}

/** A viewer's microphone in the device's offer. */
const voice = (viewerId: string, mid: string, room = ROOM, generation = 1) => ({
  deviceId: "",
  trackName: "microphone",
  mid,
  generation,
  viewerId,
  room,
});

describe("device voices", () => {
  test("a device plays every microphone in its room: the SFU's offer, the device's answer", async () => {
    const calls = mockSfu();
    const cam = await device();
    const alice = await viewer("Alice");
    await publish(cam);
    await alice.device(CAM, "live");

    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    expect(await cam.next("offer")).toEqual({ sdp: "v=0 subscriber-offer", tracks: [voice("Alice", "100")], sessionReset: false });
    expect(devicePulls(calls).map((call) => call.body.tracks)).toEqual([
      [{ location: "remote", sessionId: sessionOfOffer(calls, "Alice"), trackName: "microphone" }],
    ]);

    cam.send("answer", { sdp: "v=0 device-answer" });
    const session = deviceSession(calls);
    const renegotiate = await callMatching(calls, (call) => call.path.endsWith(`/sessions/${session}/renegotiate`));
    expect(renegotiate.body.sessionDescription).toEqual({ type: "answer", sdp: "v=0 device-answer" });

    // No offer is waiting now.
    cam.send("answer", { sdp: "v=0 stray-answer" });
    expect(await cam.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_NO_OFFER, request: "answer" });

    // The speaker leaves: the device's pull of it is closed, which the device answers too.
    alice.send("leave");
    expect(await cam.next("offer")).toEqual({ sdp: "v=0 close-offer", tracks: [], sessionReset: false });
    const close = await callMatching(calls, (call) => call.path.endsWith(`/sessions/${session}/tracks/close`));
    expect(close.body.tracks).toEqual([{ mid: "100" }]);
    cam.close();
  });

  test("a forced close needs no answer, so the next pull goes at once", async () => {
    const calls = mockSfu({ closeWithoutOffer: true });
    const cam = await device();
    const alice = await viewer("Alice");
    const bob = await viewer("Bob");
    await publish(cam);
    await alice.device(CAM, "live");
    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    expect((await cam.next("offer")).tracks).toEqual([voice("Alice", "100")]);
    cam.send("answer", { sdp: "v=0 device-answer" });

    // Bob publishes while Alice leaves: the close needs no SDP, and Bob's pull follows it.
    alice.send("leave");
    publishMicrophone(bob, "Bob");
    await bob.next("answer");
    const session = deviceSession(calls);
    await callMatching(calls, (call) => call.path.endsWith(`/sessions/${session}/tracks/close`));
    expect((await cam.next("offer")).tracks).toEqual([voice("Bob", "101")]);
    for (const ws of [cam, bob]) ws.close();
  });

  test("a microphone published before the device is live is pulled once it is", async () => {
    mockSfu();
    const cam = await device();
    const alice = await viewer("Alice");
    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    await publish(cam);
    expect((await cam.next("offer")).tracks).toEqual([voice("Alice", "100")]);
    for (const ws of [cam, alice]) ws.close();
  });

  test("one negotiation at a time: a change waits for the device's answer", async () => {
    const calls = mockSfu();
    const cam = await device();
    const alice = await viewer("Alice");
    const bob = await viewer("Bob");
    await publish(cam);
    await alice.device(CAM, "live");

    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    expect((await cam.next("offer")).tracks).toEqual([voice("Alice", "100")]);
    publishMicrophone(bob, "Bob");
    await bob.next("answer");
    await sleep(200);
    expect(cam.has("offer")).toBe(false);
    expect(devicePulls(calls)).toHaveLength(1);

    cam.send("answer", { sdp: "v=0 device-answer" });
    expect((await cam.next("offer")).tracks).toEqual([voice("Alice", "100"), voice("Bob", "101")]);
    expect(devicePulls(calls)).toHaveLength(2);
    for (const ws of [cam, alice, bob]) ws.close();
  });

  test("a device that published without voices pulls none", async () => {
    const calls = mockSfu();
    const cam = await device();
    const alice = await viewer("Alice");
    await publish(cam, false);
    await alice.device(CAM, "live");
    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    await sleep(200);
    expect(cam.has("offer")).toBe(false);
    expect(devicePulls(calls)).toHaveLength(0);
    for (const ws of [cam, alice]) ws.close();
  });

  test("a device in two rooms plays both, each microphone with its room", async () => {
    mockSfu();
    const cam = await device([ROOM, "voice-2"]);
    const alice = await viewer("Alice");
    await publish(cam);
    await alice.device(CAM, "live");
    const otherAlice = await viewer("Alice", "voice-2");

    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    expect((await cam.next("offer")).tracks).toEqual([voice("Alice", "100")]);
    cam.send("answer", { sdp: "v=0 device-answer" });
    publishMicrophone(otherAlice, "Alice");
    await otherAlice.next("answer");
    expect((await cam.next("offer")).tracks).toEqual([voice("Alice", "100"), voice("Alice", "101", "voice-2")]);
    for (const ws of [cam, alice, otherAlice]) ws.close();
  });

  test("a device that does not answer plays no voices until it publishes again", async () => {
    mockSfu();
    const cam = await device();
    const alice = await viewer("Alice");
    const bob = await viewer("Bob");
    await publish(cam);
    await alice.device(CAM, "live");
    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    await cam.next("offer");

    const stub = env.DEVICES.getByName(CAM);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE voice_state SET offer_sent_at = ?", Date.now() - 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await cam.next("error")).toMatchObject({ code: ErrorCode.ERROR_CODE_SFU, request: "answer" });

    publishMicrophone(bob, "Bob");
    await bob.next("answer");
    await sleep(200);
    expect(cam.has("offer")).toBe(false);
    for (const ws of [cam, alice, bob]) ws.close();
  });

  test("a microphone the SFU cannot pull yet is tried again later", async () => {
    mockSfu({ missingTrack: "microphone" });
    const cam = await device();
    const alice = await viewer("Alice");
    await publish(cam);
    await alice.device(CAM, "live");
    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    // The fake SFU still sends an offer; the microphone is not in it.
    expect((await cam.next("offer")).tracks).toEqual([]);
    cam.send("answer", { sdp: "v=0 device-answer" });
    await sleep(200);
    expect(cam.has("offer")).toBe(false);

    mockSfu();
    const stub = env.DEVICES.getByName(CAM);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE voice_state SET retry_at = ?", Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await cam.next("offer")).tracks).toEqual([voice("Alice", "100")]);
    for (const ws of [cam, alice]) ws.close();
  });

  test("a device stored before voices gets the new tables", async () => {
    mockSfu();
    const first = await device();
    const stub = env.DEVICES.getByName(CAM);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE voices; DROP TABLE voice_pulls; DROP TABLE voice_state;");
    });
    await expect(runInDurableObject(stub, (_instance, state) => state.abort("deploy"))).rejects.toThrow();
    first.close();

    const cam = await device();
    const alice = await viewer("Alice");
    await publish(cam);
    publishMicrophone(alice, "Alice");
    await alice.next("answer");
    expect((await cam.next("offer")).tracks).toEqual([voice("Alice", "100")]);
    for (const ws of [cam, alice]) ws.close();
  });
});
