# Run it on your computer

Start the worker on your computer, and watch a test camera in your browser. You need Node.js 22 or newer and a Cloudflare account.

## 1. Create a Realtime SFU app

1. In the Cloudflare dashboard, go to **Realtime > SFU**.
2. Create an application. Use a separate one for development.
3. Copy its **App ID** and **API token**.

## 2. Get the code

```sh
git clone https://github.com/mazupo/cf-sfu-worker.git
cd cf-sfu-worker
npm install
```

## 3. Make the keys

```sh
npm run keys
```

It prints two key pairs:

```
DEVICE_PRIVATE_KEY=MC4CAQAwBQYDK2VwBCIEI...
DEVICE_PUBLIC_KEY=q3Vb0Zr6...

VIEWER_PRIVATE_KEY=MC4CAQAwBQYDK2VwBCIEI...
VIEWER_PUBLIC_KEY=Xk9f2LmP...
```

- The private keys stay in the worker.
- Devices send the device public key. Viewers send the viewer public key.

## 4. Fill in `.dev.vars`

```sh
cp .dev.vars.example .dev.vars
```

Set these four values:

```ini
REALTIME_SFU_APP_ID=<App ID>
REALTIME_SFU_BEARER_TOKEN=<API token>
DEVICE_PRIVATE_KEY=<from npm run keys>
VIEWER_PRIVATE_KEY=<from npm run keys>
```

## 5. Start the worker

```sh
npm run dev
```

The worker runs at `http://localhost:8787`.

## 6. Watch the test camera

1. Open [localhost:8787/sfu/device](http://localhost:8787/sfu/device). This page acts as a camera.
2. Enter the **Device public key** and a room, such as `lab-a`. Click **Connect**. The state shows `sleeping`.
3. In another tab, open [localhost:8787/sfu/](http://localhost:8787/sfu/).
4. Enter the **Viewer public key** and the same room. Click **Join**.

The camera wakes and the video shows in a few seconds. Click **Leave**: about 30 seconds later, the camera goes back to `sleeping`.

## Try more

- **Data channels**: check **Enable IPC** on both pages before you connect. Then send messages both ways.
- **Server state**: open it on either page to see what the worker holds.
- **Dashboard**: [localhost:8787/sfu/admin/](http://localhost:8787/sfu/admin/) lists every room.
- **Other devices**: `npm run dev` listens on all interfaces. Use `http://<your computer's IP>:8787` from your network. The **Camera** source works only on `localhost` or `https`.

## Next

- [Connect pi-webrtc](pi-webrtc.md) to stream a real camera.
- [Deploy](../deployment/deploy.md) the worker to your Cloudflare account.
