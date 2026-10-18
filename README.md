# cf-sfu-worker

A Cloudflare Worker that connects camera devices to [Cloudflare Realtime SFU](https://developers.cloudflare.com/realtime/sfu/).
Devices wait on a WebSocket and publish video only while someone watches.

> Work in progress. ARCHITECTURE.md, PRODUCTION.md and TROUBLESHOOTING.md come later.

## How it works

- Each device has one Durable Object (`Device`). Each room has one Durable Object (`Room`). Viewers live in their room's object.
- A device connects and waits. Its Durable Object hibernates. The device sends `ping` every 15 seconds, and the runtime answers `pong` without waking the object. While someone watches, a device that sends no ping for 45 seconds shows as offline.
- A device that closes its socket normally (1000 or 1001) leaves its rooms right away. One that drops without closing, for example when its process is killed, shows as offline after 10 seconds and leaves its rooms after a minute with no ping. It joins them again when it reconnects. A device that left every room forgets its state, and its `generation` starts again from 1.
- A deploy closes every socket. Devices and viewers connect again with the same IDs and keep their streams and subscriptions.
- When the first viewer joins a room, each device in the room gets `wake`. The device opens a PeerConnection and sends an `offer`. The worker publishes it to the SFU and sends back the `answer`. When the PeerConnection is connected, the device sends `ready`, and viewers can pull its tracks.
- To make the first video appear sooner, the worker creates SFU sessions early: a device's session when it sends `wake`, and a viewer's session when the viewer joins. Rooms learn about state changes in the background, so updates to rooms never hold up a device.
- 30 seconds after the last viewer leaves, the device gets `sleep` and stops publishing.
- A device can also open two data channels, `_lossy` and `_reliable`, the ones of pi-webrtc's `--enable-ipc`. Its messages reach every viewer that opened them. Only one viewer at a time controls the device, and only that viewer's messages reach it.
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

To try the data channels, check **Enable IPC** on both pages before you connect. On the viewer, click **Take control** on the device's tile, then send a message. It shows up in the simulator's **IPC messages**. Messages the simulator sends show up on every viewer with IPC.

Both pages ping from a Web Worker, so they stay online in a background tab.

Open **Server state** on either page to see what the Durable Objects hold, refreshed every 2 seconds: each device's state, generation, socket and last ping, which rooms watch it, and each viewer's subscriptions. The debug routes behind it (`GET /cloudflare/debug/rooms/:roomId` and `GET /cloudflare/debug/devices/:deviceId`) answer only on `localhost`, or when the worker has `DEBUG_STATE=true`. They show SFU session IDs, so keep them off in production.

### Dashboard

Open `/dashboard` to see every room this worker serves: how many rooms, viewers and devices there are, and one row per room. Click a room to see its devices and viewers, the same tables as **Server state**.

The page refreshes every minute. Under **Auto refresh**, pick 3 s, 1 min, 5 min or Off, or press **Refresh**. It does not refresh while the tab is hidden. Each refresh is one request to the worker and one to the Registry, plus one to each open room, so a longer interval uses fewer of your plan's requests.

On `localhost` it works as it is. Anywhere else, set a secret `ADMIN_KEY` on the worker (`npx wrangler secret put ADMIN_KEY`, any long random string) and enter it on the page. Without that secret, `/cloudflare/admin/*` answers only on `localhost`.

Durable Objects cannot list their instances, so each Room reports to one `Registry` Durable Object when its viewers or devices change, and once a minute while it is in use. A device that goes away leaves its rooms after a minute, even when nobody watches it or its socket closed without a close event, as on a deploy: a connected device checks its socket every 5 minutes. Each worker deployment has its own Registry. A room shows a device's state only while someone in that room watches it; otherwise the dashboard says `unwatched`, and the room's details read the device itself.

## Protocol

### 1. Get a token

```http
POST /cloudflare/token
Authorization: Bearer <public key>
Content-Type: application/json

{ "device_id": "cam-1", "room_ids": ["lab-a"], "can_subscribe": false }
```

A viewer sends `{ "viewer_id": "7f3a9c2e", "room_id": "lab-a", "can_subscribe": true }` with the viewer public key. Add `"data_channels": true` to let the viewer open the devices' data channels and take control of a device. A viewer without it only watches.

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
| Device → worker | `offer` | `sdp`, `tracks: [{ mid, trackName }]`, `dataChannels` |
| Worker → device | `answer` | `generation`, `sdp` |
| Worker → device | `channels` | `channels: [{ label, id }]`: the device's `_lossy` and `_reliable` |
| Worker → device | `control` | `controller`: who controls the device now. Only for the log. |
| Device → worker | `ready` | Nothing. Send it when the PeerConnection is connected. Viewers can subscribe only after it. |
| Worker → device | `sleep` | Nothing. Close the PeerConnection. |
| Worker → viewer | `joined` | `viewerId`, `room`, `resumed`, `iceServers`, `devices`, `subscriptions`, `data`, `viewers` |
| Worker → viewer | `device` | One device's new state, with `dataChannels`, `controller`, `handover` and `waiting` |
| Worker → viewer | `members` | The room's devices changed |
| Worker → viewer | `viewers` | The room's viewers changed: each has `viewerId`, `dataChannels` and `away` (the socket closed, and it may come back) |
| Viewer → worker | `subscribe` | `tracks: [{ deviceId, trackName }]`, `data: [deviceId]` |
| Worker → viewer | `offer` | `sdp`, `tracks`, `sessionReset` |
| Viewer → worker | `answer` | `sdp` |
| Worker → viewer | `subscribed` | `tracks`, `data: [{ deviceId, generation, channels, canReply }]` |
| Viewer → worker | `unsubscribe` | `mids`, `data: [deviceId]` |
| Viewer → worker | `take_control` | `deviceId` |
| Viewer → worker | `release_control` | `deviceId` |
| Viewer → worker | `control_ready` | `deviceId` |
| Viewer → worker | `offer` | `sdp`: the viewer's own offer, right after `joined`, and again from a new PeerConnection when the last one failed |
| Worker → viewer | `answer` | `sdp`: the SFU's answer to it |
| Viewer → worker | `leave` | |
| Worker → both | `error` | `code`, `message`, `request`, `deviceId`, `trackName`, `retryable` |

The proto file also defines the device states (`DeviceState`), the error codes (`ErrorCode`) and the close codes (`CloseCode`). Close code `4000` means another connection used the same `device_id` or `viewer_id`. Do not reconnect after it.

The TypeScript for these messages is generated into `src/proto` and is not in git. `npm run dev`, `npm run deploy` and `npm run check` generate it from the `external/protocol` submodule. To run the tests or the typecheck on their own, run `npm run proto` first. It uses [buf](https://buf.build) from npm, so you do not need to install `protoc`. To change the messages, edit the proto files in `external/protocol`.

The `generation` counts a device's publications. It goes up by one with each offer the worker answers, so viewers know when their tracks belong to an old publication.

The worker replies to each offer, in order, with `answer` or an `error` for `offer`. A device uses only the reply to its last offer: one it sent before a new `wake` may still get a reply.

A device that reconnects while it publishes adds `"generation"` from its last `answer` to the token request, so the stream continues. Otherwise the worker starts over: `joined` says `sleeping`, and a new `wake` follows if someone watches.
A viewer that reconnects with the same `viewer_id` within 30 seconds keeps its subscriptions.

### 3. Data channels

Realtime SFU sends each data channel one way, from the device to every viewer that opens it. One viewer at a time can also send back to the device. The worker decides who, with the SFU's `canReply`.

| Label | Ordered | Retransmits | Use it for |
| --- | --- | --- | --- |
| `_lossy` | no | 0 | Data where old values can be dropped, such as sensor values |
| `_reliable` | yes | until it arrives | Data that must arrive, such as commands |

Create each channel with `negotiated: true`, the `id` from the worker, and the settings above. The ids differ between the device and each viewer.

On the device:

1. Before the offer, create a negotiated channel `server-events` with id 0. Any channel puts an `m=application` section in the offer.
2. Send the offer with `dataChannels: true`.
3. After the answer, the worker sends `channels` with the ids of `_lossy` and `_reliable`. Create them.

Every viewer can send its own offer right after `joined`, and the demo viewer always does: create a negotiated channel `server-events` with id 0, then send your offer as `offer`. Apply the `answer`. The PeerConnection connects while the devices wake, so the first video shows sooner. Tracks still come with the SFU's offers. Do this again after an `offer` with `sessionReset`.

When the PeerConnection's state becomes `failed`, for example because the SFU was out of reach for a while, or when your `answer` gets an `error`, create a new one and send its own offer the same way. The worker gives it a new SFU session and forgets your tracks and channels, so subscribe again after the `answer`. You keep control of the devices you controlled. Until that `answer`, ignore any `offer` and `subscribed`: they belong to the old PeerConnection.

Subscribe only while the PeerConnection is connected: the SFU holds a subscribe until then, and the worker handles your requests one at a time, so a stuck one would hold up a new offer. A PeerConnection made while the SFU was out of reach may never connect, even after the SFU is back. When a device turns live, the SFU is reachable: if your PeerConnection is not connected 4 seconds later, start over the same way.

On a viewer whose token has `data_channels`:

1. Send your own offer as above. Data channels need it.
2. When a device is live with `dataChannels`, send `subscribe` with `data: [deviceId]`. `subscribed` lists its two channels.
3. To send to the device, send `take_control`. If somebody else controls it, you wait in line.
4. When the worker hands you control, `subscribed` has `canReply: true` for the device. Once its channels are open, send `control_ready`. If you do not do this within 5 seconds of that `subscribed`, the next viewer in line gets control.
5. Send `release_control` to give up control or your place in line. Leaving the room or closing the device's channels does the same.

Control belongs to the device, not to a room. A device in two rooms has one line for viewers of both rooms. Control stays with the viewer when the device publishes again.

The worker does not read the messages. pi-webrtc expects `protocol.Packet` from [`packet.proto`](https://github.com/mazupo/protocol/blob/main/protos/packet.proto), with the text in `raw`. The demo pages do the same.

## Tests

```sh
npm run check   # type generation check, typecheck, and the workerd tests
```

The tests run in workerd and fake the SFU API.

## License

Apache-2.0
