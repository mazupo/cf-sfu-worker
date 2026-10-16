# cf-sfu-worker

A Cloudflare Worker that connects camera devices to [Cloudflare Realtime SFU](https://developers.cloudflare.com/realtime/sfu/).
Devices wait on a WebSocket and publish video only while someone watches.

> Work in progress. ARCHITECTURE.md, PRODUCTION.md and TROUBLESHOOTING.md come later.

## How it works

- Each device has one Durable Object (`Device`). Each room has one Durable Object (`Room`). Viewers live in their room's object.
- A device connects and waits. Its Durable Object hibernates. The device sends `ping` every 15 seconds, and the runtime answers `pong` without waking the object. While someone watches, a device that sends no ping for 45 seconds shows as offline.
- A deploy closes every socket. Devices and viewers connect again with the same IDs and keep their streams and subscriptions.
- When the first viewer joins a room, each device in the room gets `wake`. The device opens a PeerConnection and sends an `offer`. The worker publishes it to the SFU and sends back the `answer`. When the PeerConnection is connected, the device sends `ready`, and viewers can pull its tracks.
- To make the first video appear sooner, the worker creates SFU sessions early: a device's session when it sends `wake`, and a viewer's session when the viewer joins. Rooms learn about state changes in the background, so updates to rooms never hold up a device.
- 30 seconds after the last viewer leaves, the device gets `sleep` and stops publishing.
- The SFU secret stays in the Worker. Viewers never see a device's SFU session ID.

## Run it locally

```sh
git submodule update --init       # mazupo/protocol: the message definitions
npm install
npm run keys                      # prints a device key pair and a viewer key pair
cp .dev.vars.example .dev.vars    # then fill it in
npm run dev
```

`npm run dev` listens on all network interfaces, so a device on your network can connect to `http://<your computer's IP>:8787`. Your firewall may ask you to allow it.

In `.dev.vars`:

- `REALTIME_SFU_APP_ID` and `REALTIME_SFU_BEARER_TOKEN`: from the Cloudflare dashboard, **Realtime > SFU**. Create an app just for development.
- `DEVICE_PRIVATE_KEY` and `VIEWER_PRIVATE_KEY`: the private keys from `npm run keys`.

Keep the public keys. Devices and viewers use them.

Then open two browser tabs:

1. `http://localhost:8787/device`: the device simulator. Paste the device public key and click **Connect**.
2. `http://localhost:8787/`: the viewer. Paste the viewer public key, use the same room, and click **Join**.

The simulator starts publishing when the viewer joins, and stops 30 seconds after the viewer leaves.

Both pages ping from a Web Worker, so they stay online in a background tab.

Open **Server state** on either page to see what the Durable Objects hold, refreshed every 2 seconds: each device's state, generation, socket and last ping, which rooms watch it, and each viewer's subscriptions. The debug routes behind it (`GET /cloudflare/debug/rooms/:roomId` and `GET /cloudflare/debug/devices/:deviceId`) answer only on `localhost`, or when the worker has `DEBUG_STATE=true`. They show SFU session IDs, so keep them off in production.

## Protocol

### 1. Get a token

```http
POST /cloudflare/token
Authorization: Bearer <public key>
Content-Type: application/json

{ "device_id": "cam-1", "room_ids": ["lab-a"], "can_subscribe": false }
```

A viewer sends `{ "viewer_id": "7f3a9c2e", "room_id": "lab-a", "can_subscribe": true }` with the viewer public key.

The answer is `{ "token": "...", "expires_in": 30, "url": "wss://.../cloudflare/rtc" }`. The token works once and only for 30 seconds.

### 2. Open the socket

```
wss://<host>/cloudflare/rtc?access_token=<token>
```

Messages are protobuf, defined in [`protos/cloudflare.proto`](https://github.com/mazupo/protocol/blob/main/protos/cloudflare.proto) of [mazupo/protocol](https://github.com/mazupo/protocol). Each binary frame is one message:

- A device sends `DeviceRequest` and receives `DeviceResponse`.
- A viewer sends `ViewerRequest` and receives `ViewerResponse`.

Each of these sets exactly one field, listed below. `ping` and `pong` are text frames.

| From | Field | Contents |
| --- | --- | --- |
| Worker → device | `joined` | `deviceId`, `state`, `generation`, `rooms`, `iceServers` |
| Worker → device | `wake` | Nothing. Publish from the start: close any PeerConnection, create a new one and send an offer. |
| Device → worker | `offer` | `sdp`, `tracks: [{ mid, trackName }]` |
| Worker → device | `answer` | `generation`, `sdp` |
| Device → worker | `ready` | Nothing. Send it when the PeerConnection is connected. Viewers can subscribe only after it. |
| Worker → device | `sleep` | Nothing. Close the PeerConnection. |
| Worker → viewer | `joined` | `viewerId`, `room`, `resumed`, `iceServers`, `devices`, `subscriptions` |
| Worker → viewer | `device` | One device's new state |
| Worker → viewer | `members` | The room's devices changed |
| Viewer → worker | `subscribe` | `tracks: [{ deviceId, trackName }]` |
| Worker → viewer | `offer` | `sdp`, `tracks`, `sessionReset` |
| Viewer → worker | `answer` | `sdp` |
| Worker → viewer | `subscribed` | `tracks` |
| Viewer → worker | `unsubscribe` | `mids` |
| Viewer → worker | `leave` | |
| Worker → both | `error` | `code`, `message`, `request`, `deviceId`, `trackName`, `retryable` |

The proto file also defines the device states (`DeviceState`), the error codes (`ErrorCode`) and the close codes (`CloseCode`). Close code `4000` means another connection used the same `device_id` or `viewer_id`. Do not reconnect after it.

The TypeScript for these messages is generated into `src/proto` and is not in git. `npm run dev`, `npm run deploy` and `npm run check` generate it from the `external/protocol` submodule. To run the tests or the typecheck on their own, run `npm run proto` first. It uses [buf](https://buf.build) from npm, so you do not need to install `protoc`. To change the messages, edit the proto files in `external/protocol`.

The `generation` counts a device's publications. It goes up by one with each offer the worker answers, so viewers know when their tracks belong to an old publication.

The worker replies to each offer, in order, with `answer` or an `error` for `offer`. A device uses only the reply to its last offer: one it sent before a new `wake` may still get a reply.

A device that reconnects while it publishes adds `"generation"` from its last `answer` to the token request, so the stream continues. Otherwise the worker starts over: `joined` says `sleeping`, and a new `wake` follows if someone watches.
A viewer that reconnects with the same `viewer_id` within 30 seconds keeps its subscriptions.

## Tests

```sh
npm run check   # type generation check, typecheck, and the workerd tests
```

The tests run in workerd and fake the SFU API.

## License

Apache-2.0
