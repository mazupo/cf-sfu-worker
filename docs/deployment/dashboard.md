# Dashboard

The dashboard at `/cloudflare/admin/` lists every room, with its devices and viewers. This page shows how to open it on a deployed worker, and where to find the debug pages and the logs.

On `localhost`, the dashboard is always open. On any other host, it answers `404` until you protect it in one of these two ways.

## Cloudflare Access (recommended)

1. In the Cloudflare dashboard, go to **Zero Trust > Access > Applications**.
2. Add a **self-hosted** application for your hostname, with the path `cloudflare/admin`.
   Protect only this path. Devices and viewers need the token API and the sockets.
3. Add a policy that allows your email address.
4. Copy the application's **AUD tag**.
5. Set two secrets:

   ```sh
   npx wrangler secret put ACCESS_TEAM_DOMAIN   # https://<your-team>.cloudflareaccess.com
   npx wrangler secret put ACCESS_AUD           # the AUD tag
   ```

With these two secrets, only Access opens the dashboard. `ADMIN_KEY` no longer works.

## ADMIN_KEY

Set a long random key:

```sh
npx wrangler secret put ADMIN_KEY
```

Then enter it in **Admin key** on the dashboard.

## Debug pages

**Server state** on the demo pages reads these:

- `/cloudflare/debug/rooms/<room ID>`: a room, its viewers and its devices.
- `/cloudflare/debug/devices/<device ID>`: one device.

They need `Authorization: Bearer <device or viewer public key>`. On `localhost` they are always on. On other hosts, they answer `404` unless `DEBUG_STATE` is `true`. They show SFU session IDs, so turn them on only while you test.

## Logs

The worker writes one JSON line for each event, such as `device_gone`, `viewer_stale` or `device_id_in_use`. To watch them:

```sh
npx wrangler tail
```

You can also search them in the Cloudflare dashboard, under your worker's **Observability** tab.
