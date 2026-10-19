import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { ErrorCode } from "../../src/proto/cloudflare";
import { connect, mockSfu, sessionOf, type SfuCall, type TestSocket, viewerToken } from "./helpers";

const ROOM = "voice";

/** Joins and has its own offer answered, so its session can carry a microphone. */
async function viewer(viewerId: string): Promise<TestSocket> {
  const ws = await connect(await viewerToken(viewerId, ROOM));
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
    expect(offer.tracks).toEqual([{ deviceId: "", viewerId: "Alice", trackName: "microphone", mid: "100", generation: 1 }]);
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
