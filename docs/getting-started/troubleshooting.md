# Troubleshooting

Common errors, and how to fix them. Errors from the token API come as `{ "error": { "code", "message" } }`.

## Token API

| Status and code | Meaning |
| --- | --- |
| `401 key_required` | Send `Authorization: Bearer <public key>`. |
| `401 key_invalid` | The public key does not belong to this worker. Check that it matches the private key in the worker. |
| `401 role_mismatch` | A device key was used for a viewer, or a viewer key for a device. |
| `400 body_invalid` | A field in the body is wrong. The message names it. |
| `400 too_many_rooms` | A device asked for more than `MAX_ROOMS_PER_DEVICE` rooms. |
| `429 rate_limited` | More than 20 token requests in a minute from one IP address. Wait a minute. |
| `503 key_not_configured` | `DEVICE_PRIVATE_KEY` or `VIEWER_PRIVATE_KEY` is not set in the worker. |

## Opening the socket

| Status and code | Meaning |
| --- | --- |
| `401 token_expired` | The token is older than 30 seconds. Get a new one right before you connect. |
| `401 token_used` | Each token works once. Get a new one for each connection. |
| `401 token_invalid` | The token is broken or comes from another worker. |

## Closed sockets

| Close code | Meaning |
| --- | --- |
| `4000` | A newer connection with the same ID and secret took over. The old connection should not reconnect. |
| `4001` | No ping for too long. Reconnect. |
| `4002` | Another live connection uses this ID with another secret. Give each device and viewer its own ID. Right after a power cut, it can be the device's last run: wait a minute. |

## Video does not show

| What you see | What to do |
| --- | --- |
| The device stays `waking`, then the viewer gets `ERROR_CODE_WAKE_TIMEOUT` | The device could not reach the SFU. Check that UDP is not blocked. Add [TURN](../deployment/configuration.md#secrets) for strict networks. |
| `Send a binary ViewerRequest.` or `Send a binary DeviceRequest...` | The client and the worker use different message versions. Update the client, or run `git submodule update` and restart the worker. |
| `ERROR_CODE_VIEWER_LIMIT` | The device already has `MAX_VIEWERS_PER_DEVICE` viewers. |
| `ERROR_CODE_ROOM_FULL` | The room already has `MAX_DEVICES_PER_ROOM` devices. |
| The **Camera** source is missing on the device simulator | Browsers allow the camera only on `localhost` or `https`. Use **Test pattern**. |

## Pages

| What you see | What to do |
| --- | --- |
| `/cloudflare/admin/` answers `404` on a deployed worker | Set up [Access or ADMIN_KEY](../deployment/dashboard.md). |
| `/cloudflare/debug/*` answers `404` on a deployed worker | Set `DEBUG_STATE` to `true`. See [Debug pages](../deployment/dashboard.md#debug-pages). |
