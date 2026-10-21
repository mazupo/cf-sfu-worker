# Token API

A device or a viewer trades a public key for a short access token. Then it opens a WebSocket with that token.

## Request

```http
POST /sfu/token
Authorization: Bearer <public key>
Content-Type: application/json
```

A device sends the device public key:

```json
{ "device_id": "cam-1", "room_ids": ["lab-a"], "can_subscribe": false, "secret": "9c1e4f0b7a2d6e8f3b5c1a9d" }
```

| Field | Rules |
| --- | --- |
| `device_id` | 1 to 64 letters, digits, `.`, `_` or `-`. It starts with a letter or a digit. |
| `room_ids` | 1 to 4 room IDs (`MAX_ROOMS_PER_DEVICE`), in the same format. |
| `can_subscribe` | `false` |
| `secret` | See [The secret](#the-secret). |
| `generation` | Optional. The `generation` of the last `answer`. Send it after a reconnect to keep the stream. |

A viewer sends the viewer public key:

```json
{ "viewer_id": "Ana", "room_id": "lab-a", "can_subscribe": true, "secret": "f04c9a1e7b3d5e2c8a6b0d4f" }
```

| Field | Rules |
| --- | --- |
| `viewer_id` | 1 to 64 letters (any language), digits, spaces, `.`, `_` or `-`. No space at the start or the end. Other viewers see it. |
| `room_id` | One room ID. |
| `can_subscribe` | `true` |
| `secret` | See [The secret](#the-secret). |
| `data_channels` | Optional. `true` lets the viewer open the devices' [data channels](data-channels.md) and take control. |

## Response

```json
{ "token": "eyJhbGciOiJFZERTQSIs...", "expires_in": 30, "url": "wss://example.com/sfu/rtc" }
```

The token works once, within `expires_in` seconds. Get a new token for each connection.

## The secret

`secret` is a random string of 16 to 128 characters. Make it once, and send the same one on every reconnect. A device makes one each time it starts. A viewer keeps one with its `viewer_id`.

- Same ID, same secret: the new connection replaces the old one. The old one is closed with `4000`. A viewer that comes back within 30 seconds keeps its streams.
- Same ID, another secret: refused with `4002` while the old connection is live.

The token holds only a hash of the secret.

## Open the socket

```
wss://<host>/sfu/rtc?access_token=<token>
```

Then see [Messages](messages.md). For errors, see [Troubleshooting](../getting-started/troubleshooting.md).
