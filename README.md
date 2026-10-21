# cf-sfu-worker

A Cloudflare Worker that connects cameras to [Cloudflare Realtime SFU](https://developers.cloudflare.com/realtime/sfu/). A device publishes only while someone watches.

## How it works

- Each device and each room has its own Durable Object. Viewers live in their room's object.
- A device connects and waits. It sends `ping` every 15 s. With no ping for 45 s, it shows offline.
- When the first viewer joins a room, its devices get `wake` and start publishing.
- 30 s after the last viewer leaves, the devices get `sleep` and stop.
- A device that closes its socket normally leaves its rooms at once. One that drops leaves them after a minute.
- A deploy closes every socket. Devices and viewers reconnect and keep their streams.
- A device can open two data channels, `_lossy` and `_reliable`. Only one viewer at a time can send to it.
- Viewers in a room can talk. The room's devices play their voices.
- The SFU token stays in the worker.

## Run it locally

```sh
git submodule update --init       # the message definitions
npm install
npm run keys                      # a device key pair and a viewer key pair
cp .dev.vars.example .dev.vars    # then fill it in
npm run dev
```

In `.dev.vars`:

- `REALTIME_SFU_APP_ID`, `REALTIME_SFU_BEARER_TOKEN`: from **Realtime > SFU** in the Cloudflare dashboard. Use a separate app for development.
- `DEVICE_PRIVATE_KEY`, `VIEWER_PRIVATE_KEY`: from `npm run keys`. Give the public keys to devices and viewers.

Then open two tabs:

1. `http://localhost:8787/cloudflare/device`: the device simulator. Enter the device public key and a room, then click **Connect**.
2. `http://localhost:8787/cloudflare/`: the viewer. Enter the viewer public key and the same room, then click **Join**.

Check **Enable IPC** on both pages to try the data channels. **Server state** on either page shows what the Durable Objects hold.

`npm run dev` listens on all interfaces, so a device on your network can use `http://<your computer's IP>:8787`.

## Deploy

1. Create a Realtime SFU app in the Cloudflare dashboard.
2. Run `npm run keys`. Keep the public keys.
3. Set the secrets:

   ```sh
   npx wrangler secret put REALTIME_SFU_APP_ID
   npx wrangler secret put REALTIME_SFU_BEARER_TOKEN
   npx wrangler secret put DEVICE_PRIVATE_KEY
   npx wrangler secret put VIEWER_PRIVATE_KEY
   ```

4. Run `npm run deploy`.

To serve it on your own domain, add a route such as `example.com/cloudflare/*` in `wrangler.jsonc`. The pages and the API are all under `/cloudflare/`.

Optional secrets:

| Secret | Use |
| --- | --- |
| `REALTIME_TURN_KEY_ID`, `REALTIME_TURN_KEY_API_TOKEN` | Add TURN servers. |
| `ADMIN_KEY` | Open the dashboard with this key. |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Put the dashboard behind Cloudflare Access. |

Settings in `wrangler.jsonc` (`vars`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | `*` | Origins that may call the token API |
| `MAX_VIEWERS_PER_DEVICE` | 10 | |
| `MAX_DEVICES_PER_ROOM` | 16 | |
| `MAX_ROOMS_PER_DEVICE` | 4 | |
| `MAX_MICROPHONES_PER_ROOM` | 10 | |
| `IDLE_LINGER_SECONDS` | 30 | How long a device keeps publishing after the last viewer leaves |
| `VIEWER_RESUME_SECONDS` | 30 | How long a viewer can come back and keep its streams |
| `DEBUG_STATE` | `false` | `true` opens `/cloudflare/debug/*` on any host. It shows SFU session IDs. |

## Dashboard

`/cloudflare/admin/` lists every room with its devices and viewers. On `localhost` it is open. Anywhere else, protect it:

- **Cloudflare Access** (recommended):
  1. In **Zero Trust > Access > Applications**, add a self-hosted application for the path `cloudflare/admin` on your hostname. Do not protect the whole worker: devices and viewers need the token API and WebSockets.
  2. Allow your email address.
  3. Set the secrets `ACCESS_TEAM_DOMAIN` (`https://<your-team>.cloudflareaccess.com`) and `ACCESS_AUD` (the application's AUD tag).
- **ADMIN_KEY**: set the secret and enter it on the page.

## Protocol

### 1. Get a token

```http
POST /cloudflare/token
Authorization: Bearer <public key>
Content-Type: application/json

{ "device_id": "cam-1", "room_ids": ["lab-a"], "can_subscribe": false, "secret": "9c1e4f0b7a2d6e8f3b5c1a9d" }
```

A viewer sends `{ "viewer_id": "7f3a9c2e", "room_id": "lab-a", "can_subscribe": true, "secret": "..." }` with the viewer public key. Add `"data_channels": true` to use data channels.

The answer is `{ "token": "...", "expires_in": 30, "url": "wss://.../cloudflare/rtc" }`. A token works once, for 30 s.

`secret` is a random string of 16 to 128 characters. Make it once and send the same one on every reconnect:

- Same id, same secret: the new connection replaces the old one (close code `4000`).
- Same id, another secret: refused (close code `4002`) while the old connection is live.

### 2. Open the socket

```
wss://<host>/cloudflare/rtc?access_token=<token>
```

Messages are protobuf, defined in `protos/cloudflare.proto` of [mazupo/protocol](https://github.com/mazupo/protocol). Each binary frame is one message. A device sends `DeviceRequest` and gets `DeviceResponse`. A viewer sends `ViewerRequest` and gets `ViewerResponse`. `ping` and `pong` are text frames.

| From | Message | Contents |
| --- | --- | --- |
| Worker → device | `joined` | `deviceId`, `state`, `generation`, `rooms`, `iceServers` |
| Worker → device | `wake` | Start publishing: a new PeerConnection and an offer. |
| Device → worker | `offer` | `sdp`, `tracks: [{ mid, trackName }]`, `dataChannels`, `voices` |
| Worker → device | `answer` | `generation`, `sdp` |
| Device → worker | `ready` | The PeerConnection is connected. |
| Worker → device | `channels` | The ids of `_lossy` and `_reliable` |
| Worker → device | `control` | Who controls the device |
| Worker → device | `offer` | The SFU's offer for the viewers' voices |
| Device → worker | `answer` | The answer to it |
| Worker → device | `sleep` | Close the PeerConnection. |
| Worker → viewer | `joined` | `viewerId`, `room`, `resumed`, `iceServers`, `devices`, `subscriptions`, `data`, `viewers` |
| Worker → viewer | `device` | One device's new state |
| Worker → viewer | `members` | The room's devices changed. |
| Worker → viewer | `viewers` | The room's viewers changed. |
| Viewer → worker | `offer` | The viewer's own offer |
| Worker → viewer | `answer` | The SFU's answer to it |
| Viewer → worker | `subscribe` | `tracks`, `data: [deviceId]`, `microphones: [viewerId]` |
| Worker → viewer | `offer` | The SFU's offer: `sdp`, `tracks`, `sessionReset` |
| Viewer → worker | `answer` | The answer to it |
| Worker → viewer | `subscribed` | `tracks`, `data` |
| Viewer → worker | `unsubscribe` | `mids`, `data` |
| Viewer → worker | `take_control`, `release_control`, `control_ready` | `deviceId` |
| Viewer → worker | `mute` | `muted` |
| Viewer → worker | `leave` | |
| Worker → both | `error` | `code`, `message`, `request`, `deviceId`, `viewerId`, `trackName`, `retryable` |

Devices:

- Use only the reply to your last offer.
- Send `ready` when the PeerConnection is connected. Viewers can pull your tracks only after that.
- To keep the stream after a reconnect, send `generation` from your last `answer` in the token request.
- After close code `4000` or `4002`, try again later. Two devices may use the same id.

Viewers:

- Right after `joined`, create a negotiated data channel `server-events` with id 0, then send your own `offer`.
- Answer each `offer` from the worker. After `sessionReset`, start a new PeerConnection.
- Subscribe only while the PeerConnection is connected.
- If the PeerConnection fails or your `answer` gets an `error`, start a new PeerConnection and send its offer. Then subscribe again. Your control stays.
- If it is not connected 4 s after a device turns live, start over the same way.
- Reconnect with the same `viewer_id` and `secret` within 30 s to keep your subscriptions.

The TypeScript for the messages is generated into `src/proto` (not in git). `npm run dev`, `deploy` and `check` generate it. To change the messages, edit `external/protocol`.

### 3. Data channels

The SFU sends a data channel from the device to every viewer that opens it. One viewer at a time can send back.

| Label | Ordered | Retransmits | Use |
| --- | --- | --- | --- |
| `_lossy` | no | 0 | Values you can drop, such as sensor readings |
| `_reliable` | yes | until it arrives | Commands |

Create each channel with `negotiated: true` and the `id` from the worker.

On the device:

1. Before the offer, create a negotiated channel `server-events` with id 0.
2. Send the offer with `dataChannels: true`.
3. Create `_lossy` and `_reliable` with the ids in `channels`.

On a viewer whose token has `data_channels`:

1. Send `subscribe` with `data: [deviceId]`.
2. Send `take_control`. If someone else has control, you wait in line.
3. When `subscribed` shows `canReply: true`, send `control_ready` within 5 s.
4. Send `release_control` to give up control or your place in line.

Control belongs to the device, not to a room. Messages use `protocol.Packet` from `packet.proto`, with the text in `raw`.

### 4. Voice

Viewers:

1. After the answer to your own offer, add the microphone as a `sendonly` transceiver.
2. Send `mute`, then an `offer` with `tracks: [{ trackName: "microphone", mid }]`.
3. To hear someone, send `subscribe` with `microphones: [viewerId]`.
4. When `microphoneGeneration` changes, subscribe again.

A room takes 10 microphones by default. Past that, the offer gets the error `microphone_limit`: roll it back and only listen.

Devices play the voices when their offer has `voices: true`. The worker then sends an `offer` each time the microphones change. Answer it within 10 s.

## Tests

```sh
npm run check   # generate, typecheck, and run the workerd tests
```

## License

Apache-2.0
