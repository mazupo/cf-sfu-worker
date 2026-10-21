# Connect pi-webrtc

Stream a Raspberry Pi or a Jetson camera to the worker with [pi-webrtc](https://github.com/mazupo/pi-webrtc). First install pi-webrtc on the device. See its [Getting Started](https://github.com/mazupo/pi-webrtc/blob/main/docs/getting-started/README.md).

## Run on the device

```bash
./pi-webrtc --camera=libcamera:0 \
    --uid=cam-1 \
    --use-cloudflare \
    --api-url=http://192.168.1.10:8787/sfu \
    --api-key=DEVICE_PUBLIC_KEY \
    --cloudflare-room=lab-a \
    --enable-ipc
```

- `--api-url`: the worker URL, with `/sfu` at the end. For a worker on your computer, use your computer's IP address. For a deployed worker, use `https://`.
- `--api-key`: the device public key from `npm run keys`.
- `--uid`: the device ID. Every device needs its own ID.
- `--cloudflare-room`: a room to join. Repeat it to join up to 4 rooms.
- `--enable-ipc`: opens the data channels, so viewers can send messages to the device. Without it, the device gets no messages.

The log shows `Connected to the Cloudflare worker`. The device now waits, and streams only while someone watches.

## Watch it

- **Viewer page**: open `/sfu/` on the worker, and join the same room. Check **Enable IPC** to send messages.
- **Web app**: use `CloudflareRoom` from [@mazupo/client](https://github.com/mazupo/client-sdk-js/blob/main/docs/reference/cloudflare-room.md).

## More

- Data channels, voice and log messages: see [SFU](https://github.com/mazupo/pi-webrtc/blob/main/docs/signaling/sfu.md#cloudflare-realtime) in the pi-webrtc docs.
- If it does not connect, see [Troubleshooting](troubleshooting.md).
