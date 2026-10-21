# cf-sfu-worker Documentation

cf-sfu-worker lets a team work together with embedded devices that run pi-webrtc, through Cloudflare Realtime SFU. These docs show how to run it, deploy it, and build a client for it.

## Start here

| I want to... | Read |
|---|---|
| Try it on my computer | [Run it on your computer](getting-started/local.md) |
| Stream a Raspberry Pi or a Jetson camera | [Connect pi-webrtc](getting-started/pi-webrtc.md) |
| Put it on my Cloudflare account | [Deploy](deployment/deploy.md) |
| Change a limit or a timeout | [Configuration](deployment/configuration.md) |
| Write my own device or viewer | [Token API](reference/token-api.md) and [Messages](reference/messages.md) |

## Sections

- [Getting Started](getting-started/README.md): run the worker on your computer and connect a camera.
- [Deployment](deployment/README.md): deploy to Cloudflare, configure it, and protect the dashboard.
- [Reference](reference/README.md): the token API, the socket messages, data channels and voice.
- [Development](development/README.md): how the worker works inside, and how to test it.

## Writing these docs

Readers come from all over the world, and many do not speak English as a first language. Please keep the docs simple:

- Use short sentences, with one idea in each sentence.
- Use common words. Do not use idioms.
- Give each step one action, and a command that people can copy.
- Start each page with one or two sentences that say what the page is for.
- Link to another page instead of repeating it.
- In each folder, `README.md` is the overview. The order of its links is the order of the pages on the website.
