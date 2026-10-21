# Deploy

Put the worker on your Cloudflare account. Use the Deploy button, or deploy from your computer with Wrangler.

## 1. Make the keys

In a copy of this repo, run:

```sh
npm run keys
```

Without the code, Node.js 22 or newer can make them too:

```sh
node -e 'for (const r of ["DEVICE", "VIEWER"]) { const k = require("crypto").generateKeyPairSync("ed25519"); console.log(`${r}_PRIVATE_KEY=${k.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`); console.log(`${r}_PUBLIC_KEY=${k.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url")}`) }'
```

Keep all four values. The private keys go into the worker. The public keys go to your devices and viewers.

## 2. Create a Realtime SFU app

1. In the Cloudflare dashboard, go to **Realtime > SFU**.
2. Create an application for production.
3. Copy its **App ID** and **API token**.

## 3. Deploy

### With the Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mazupo/cf-sfu-worker)

1. Click the button.
2. Cloudflare copies this repo to your GitHub or GitLab account.
3. Enter the four secrets: `REALTIME_SFU_APP_ID`, `REALTIME_SFU_BEARER_TOKEN`, `DEVICE_PRIVATE_KEY` and `VIEWER_PRIVATE_KEY`.
4. Click **Deploy**.

Each push to your copy deploys it again.

### With Wrangler

```sh
git clone https://github.com/mazupo/cf-sfu-worker.git
cd cf-sfu-worker
npm install
npx wrangler login
npm run deploy
```

Then set the secrets. Each command asks for the value:

```sh
npx wrangler secret put REALTIME_SFU_APP_ID
npx wrangler secret put REALTIME_SFU_BEARER_TOKEN
npx wrangler secret put DEVICE_PRIVATE_KEY
npx wrangler secret put VIEWER_PRIVATE_KEY
```

To update later, run `git pull` and `npm run deploy`.

## 4. Check it

The worker runs at `https://cf-sfu-worker.<your-subdomain>.workers.dev`.

```sh
curl https://cf-sfu-worker.<your-subdomain>.workers.dev/sfu/health
```

It answers `{"service":"cf-sfu-worker","ok":true}`. Then open `/sfu/device` and `/sfu/` on the same host, as in [Run it on your computer](../getting-started/local.md#6-watch-the-test-camera).

## Use your own domain

The pages and the API are all under `/sfu/`. Add a route in `wrangler.jsonc`, and deploy again:

```jsonc
"routes": [{ "pattern": "example.com/sfu/*", "zone_name": "example.com" }],
"workers_dev": false
```

The rest of `example.com` is not affected, but nothing else on it can use paths under `/sfu/`. The `mazupo` environment in `wrangler.jsonc` is the mazupo deployment. You do not need it.

## When you deploy again

A deploy closes every socket. Devices and viewers connect again within seconds, and the streams keep going.

## Next

- [Configuration](configuration.md): limits, TURN and the allowed origins.
- [Dashboard](dashboard.md): protect `/sfu/admin/`.
