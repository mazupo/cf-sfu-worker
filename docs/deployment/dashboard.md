# Dashboard

The dashboard at `/sfu/admin/` lists every room, with its devices and viewers. This page shows how to open it on a deployed worker, and where to find the debug pages and the logs.

On `localhost`, the dashboard is always open. On any other host, it answers `404` until you protect it in one of these two ways.

## Cloudflare Access (recommended)

1. In the Cloudflare dashboard, go to **Zero Trust > Access controls > Applications**.
2. Select **Create new application**, then **Self-hosted and private**.
3. Under **Destinations**, select **Add public hostname**. Enter your worker's hostname, and the path `sfu/admin`.
   For example: subdomain `cf-sfu-worker`, domain `<your-subdomain>.workers.dev`, path `sfu/admin`.
4. Add a policy that allows your email address, and save.
5. Copy the application's **Application Audience (AUD) Tag**.
6. Copy your team domain from **Zero Trust > Settings > Team domain**, such as `your-team.cloudflareaccess.com`.
7. Set two secrets, with `wrangler` or in your worker's **Settings > Variables and Secrets**:

   ```sh
   npx wrangler secret put ACCESS_TEAM_DOMAIN   # your-team.cloudflareaccess.com
   npx wrangler secret put ACCESS_AUD           # the AUD tag
   ```

Protect only the `sfu/admin` path. Do not use **Add Workers** or **Protect this Worker**: they protect the whole worker, and devices and viewers then cannot reach the token API and the sockets.

With these two secrets, only Access opens the dashboard. `ADMIN_KEY` no longer works.

## ADMIN_KEY

Set a long random key:

```sh
npx wrangler secret put ADMIN_KEY
```

Then enter it in **Admin key** on the dashboard.

## Debug pages

**Server state** on the demo pages reads these:

- `/sfu/debug/rooms/<room ID>`: a room, its viewers and its devices.
- `/sfu/debug/devices/<device ID>`: one device.

On `localhost` they are open, like the dashboard. On other hosts, they answer `404` unless `DEBUG_STATE` is `true`, and then they need `Authorization: Bearer <device or viewer public key>`. They show SFU session IDs, so turn them on only while you test.

```sh
curl -H "Authorization: Bearer <public key>" https://<your host>/sfu/debug/devices/<device ID>
```

## Logs

The worker writes one JSON line for each event, such as `device_gone`, `viewer_stale` or `device_id_in_use`. To watch them:

```sh
npx wrangler tail
```

You can also search them in the Cloudflare dashboard, under your worker's **Observability** tab.
