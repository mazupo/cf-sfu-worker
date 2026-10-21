# Messages

The messages on the socket, and the rules for devices and viewers. The messages are protobuf, defined in `protos/cloudflare.proto` of [mazupo/protocol](https://github.com/mazupo/protocol).

## Frames

- Each binary frame is one message.
- A device sends `DeviceRequest` and gets `DeviceResponse`.
- A viewer sends `ViewerRequest` and gets `ViewerResponse`.
- Send the text frame `ping` every 15 seconds. The worker answers `pong`.

## Device messages

| From | Message | Contents |
| --- | --- | --- |
| Worker → device | `joined` | `device_id`, `state`, `generation`, `rooms`, `ice_servers` |
| Worker → device | `wake` | Start streaming: make a new PeerConnection and send an offer. |
| Device → worker | `offer` | `sdp`, `tracks: [{ mid, track_name }]`, `data_channels`, `voices` |
| Worker → device | `answer` | `generation`, `sdp` |
| Device → worker | `ready` | The PeerConnection is connected. |
| Worker → device | `channels` | The ids of `_lossy` and `_reliable` |
| Worker → device | `control` | Who controls the device |
| Worker → device | `offer` | The SFU's offer for the viewers' voices |
| Device → worker | `answer` | The answer to it |
| Worker → device | `sleep` | Stop streaming: close the PeerConnection. |
| Worker → device | `error` | See [Error codes](#error-codes). |

Rules for devices:

- Use only the reply to your last offer.
- Send `ready` when the PeerConnection is connected. Viewers can pull your tracks only after that.
- To keep the stream after a reconnect, send `generation` from your last `answer` in the token request.
- After close code `4000` or `4002`, try again later. Another device may use the same ID.

## Viewer messages

| From | Message | Contents |
| --- | --- | --- |
| Worker → viewer | `joined` | `viewer_id`, `room`, `resumed`, `ice_servers`, `devices`, `subscriptions`, `data`, `viewers` |
| Worker → viewer | `device` | One device's new state |
| Worker → viewer | `members` | The room's devices changed. |
| Worker → viewer | `viewers` | The room's viewers changed. |
| Viewer → worker | `offer` | The viewer's own offer |
| Worker → viewer | `answer` | The SFU's answer to it |
| Viewer → worker | `subscribe` | `tracks`, `data: [device_id]`, `microphones: [viewer_id]` |
| Worker → viewer | `offer` | The SFU's offer: `sdp`, `tracks`, `session_reset` |
| Viewer → worker | `answer` | The answer to it |
| Worker → viewer | `subscribed` | `tracks`, `data` |
| Viewer → worker | `unsubscribe` | `mids`, `data` |
| Viewer → worker | `take_control`, `release_control`, `control_ready` | `device_id` |
| Viewer → worker | `mute` | `muted` |
| Viewer → worker | `leave` | |
| Worker → viewer | `error` | See [Error codes](#error-codes). |

Rules for viewers:

- Right after `joined`, create a negotiated data channel `server-events` with id 0. Then send your own `offer`.
- Answer each `offer` from the worker. After `session_reset`, start a new PeerConnection.
- Subscribe only while the PeerConnection is connected.
- If the PeerConnection fails, or your `answer` gets an `error`, start a new PeerConnection and send its offer. Then subscribe again. You keep your control.
- If it is not connected 4 seconds after a device turns live, start over the same way.
- Reconnect with the same `viewer_id` and `secret` within 30 seconds to keep your subscriptions.

## Device states

| State | Meaning |
| --- | --- |
| `offline` | Not connected. |
| `sleeping` | Connected, not streaming. |
| `waking` | Asked to stream. |
| `live` | Streaming. Viewers can subscribe. |

## Close codes

| Code | Meaning |
| --- | --- |
| `4000` | A newer connection with the same ID and secret took over. |
| `4001` | No ping for too long. |
| `4002` | A live connection with another secret uses this ID. |

## Error codes

`error` has `code`, `message`, `request` (the failed request, such as `offer`), `device_id`, `viewer_id`, `track_name` and `retryable`.

| Code | Meaning |
| --- | --- |
| `INVALID_MESSAGE` | The message cannot be read, or is not allowed now. |
| `INTERNAL` | Something went wrong in the worker. |
| `SFU` | A call to the SFU failed. |
| `WAKE_STALE` | The offer came after `sleep`. |
| `WAKE_TIMEOUT` | The device did not send `ready` in time. |
| `ROOM_FULL` | The room has `MAX_DEVICES_PER_ROOM` devices. |
| `ROOM_UNAVAILABLE` | The device could not join a room. |
| `BUSY` | Answer the last offer first. |
| `NO_OFFER` | There is no offer to answer. |
| `NOT_MEMBER` | The device is not in this room. |
| `NOT_LIVE` | The device is not streaming. |
| `VIEWER_LIMIT` | The device has `MAX_VIEWERS_PER_DEVICE` viewers. |
| `TRACK_NOT_FOUND` | The device has no track with this name. |
| `TRACK_NOT_READY` | The SFU could not pull the track yet. Try again. |
| `VIEWER_GONE` | The viewer is no longer in the room. Join again. |
| `NO_DATA_CHANNELS` | The device has no data channels. |
| `DATA_CHANNELS_OFF` | The token has no `data_channels`. |
| `NOT_CONTROLLER` | You do not control the device, and it is not being handed to you. |
| `CONTROL_TIMEOUT` | No `control_ready` within 5 seconds. |
| `MICROPHONE_LIMIT` | The room has `MAX_MICROPHONES_PER_ROOM` microphones. |

In the protobuf, each code has the prefix `ERROR_CODE_`.

## Generated code

The worker's TypeScript for the messages is generated into `src/proto`. It is not in git. `npm run dev`, `deploy` and `check` generate it.
