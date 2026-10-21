# Testing

Run the tests, change the messages, and find out what the worker is doing.

## Run the tests

```sh
npm run check
```

It does five things:

1. Generates `src/proto` from the protocol submodule.
2. Checks that each env in `wrangler.jsonc` repeats the top-level settings.
3. Checks that `worker-configuration.d.ts` matches `wrangler.jsonc` and `.dev.vars.example`.
4. Typechecks.
5. Runs the tests in workerd, the runtime of Cloudflare Workers. The SFU and TURN APIs are mocked.

To run one file:

```sh
npx vitest run tests/workerd/room.test.ts
```

| File | What it tests |
| --- | --- |
| `token.test.ts` | The token API and opening the socket |
| `flow.test.ts` | Device sockets, wake, publish, subscribe and sleep |
| `presence.test.ts` | Pings, offline devices and reconnects |
| `room.test.ts` | Rooms, members and limits |
| `data.test.ts` | Data channels and control |
| `voice.test.ts` | Microphones and the devices' voices |
| `admin.test.ts` | The dashboard, with a key and with Access |
| `debug.test.ts` | The debug pages |
| `pages.test.ts` | The static pages |

## Change the messages

The messages live in [mazupo/protocol](https://github.com/mazupo/protocol). This repo has it as a submodule in `external/protocol`.

1. Change the `.proto` files in `external/protocol`, on a branch.
2. Run `npm run proto`. It warns that the submodule is not at the recorded commit. That is expected while you work.
3. Merge the protocol change to its `main`.
4. Point the submodule of this repo, pi-webrtc and client-sdk-js at the same commit.

CI checks that this repo pins the same protocol commit as pi-webrtc `main`. So merge the pi-webrtc change first.

## Change the config

After you change `vars`, bindings or `.dev.vars.example`, run:

```sh
npm run cf-typegen
```

Optional secrets that are not in `.dev.vars.example` go in `src/env.d.ts`.

## Debug

- **Server state** on the demo pages shows what the Durable Objects hold. See [Debug pages](../deployment/dashboard.md#debug-pages).
- `npm run dev` prints one JSON line for each event, such as `device_gone`.
- To keep a separate local state, run `npx wrangler dev --persist-to <folder>`.
