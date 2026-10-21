# Configuration

Every secret and variable of the worker. Set secrets with `npx wrangler secret put <NAME>`, or in the dashboard under **Settings > Variables and Secrets**. Change variables in `vars` of `wrangler.jsonc`, then deploy again.

In the dashboard, choose the type **Secret**. Each deploy replaces the **Text** variables with the `vars` in `wrangler.jsonc`, so a value added as text is gone after the next deploy.

For local development, put secrets in `.dev.vars`. See `.dev.vars.example`.

## Secrets

| Secret | Required | Use |
| --- | --- | --- |
| `REALTIME_SFU_APP_ID` | yes | The App ID of your Realtime SFU app. |
| `REALTIME_SFU_BEARER_TOKEN` | yes | The API token of the same app. |
| `DEVICE_PRIVATE_KEY` | yes | Signs device tokens. From `npm run keys`. |
| `VIEWER_PRIVATE_KEY` | yes | Signs viewer tokens. From `npm run keys`. |
| `REALTIME_TURN_KEY_ID`, `REALTIME_TURN_KEY_API_TOKEN` | no | A TURN key from **Realtime > TURN**. Devices and viewers then also get TURN servers. Use it when UDP is blocked. |
| `ADMIN_KEY` | no | Opens the [dashboard](dashboard.md) with this key. |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | no | Put the [dashboard](dashboard.md) behind Cloudflare Access. |

To change a key pair, set the new private key, then give the new public key to every device or viewer. Clients with the old public key can no longer get tokens.

## Variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | `*` | Origins of the web pages that may call the token API, separated by commas. |
| `TOKEN_TTL_SECONDS` | `30` | How long an access token works. |
| `DEVICE_STALE_SECONDS` | `45` | A device with no ping for this long shows offline. |
| `WAKE_TIMEOUT_SECONDS` | `20` | How long a device has to start streaming after `wake`. It gets two tries. |
| `IDLE_LINGER_SECONDS` | `30` | How long a device keeps streaming after the last viewer leaves. |
| `VIEWER_STALE_SECONDS` | `45` | A viewer with no ping for this long is closed with `4001`. |
| `VIEWER_RESUME_SECONDS` | `30` | How long a viewer can come back and keep its streams and control. |
| `MAX_VIEWERS_PER_DEVICE` | `10` | Viewers that may watch one device at a time. |
| `MAX_DEVICES_PER_ROOM` | `16` | Devices in one room. |
| `MAX_ROOMS_PER_DEVICE` | `4` | Rooms that one device may join. |
| `MAX_MICROPHONES_PER_ROOM` | `10` | Viewers in one room that may publish a microphone. |
| `DEBUG_STATE` | `false` | `true` opens the [debug pages](dashboard.md#debug-pages) on any host. They show SFU session IDs. |

## Rate limit

`TOKEN_LIMITER` in `wrangler.jsonc` allows 20 token requests per minute from one IP address. Cloudflare counts them in each location separately. Change `simple.limit` to allow more.

Two Workers in the same account with the same `namespace_id` share their counts. Give each deployment its own `namespace_id`.

## Fixed timings

These are set in the code, in `src/server/config.ts` and in the clients:

| Value | What it does |
| --- | --- |
| 15 s | Devices and viewers send `ping` this often. |
| 10 s | A device whose socket drops shows offline after this, if it is not back. |
| 60 s | A device whose socket drops without a close leaves its rooms after this. |
| 5 s | A viewer that is given control must send `control_ready` within this. |
| 10 s | A device must answer the offer for the viewers' voices within this. |
