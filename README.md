# Relay

Relay is a local coding workspace with a shared conversation across Codex App Server,
Claude Agent SDK, and published pi npm packages. Relay owns sessions, public history,
approvals, and recovery. Each backend owns its agent loop and tools.

## Project layout

```text
apps/desktop/       Electron shell, preload bridge, worker, and browser UI
packages/core/      Shared application service, native adapters, CLI, and terminal host
docs/               Architecture and operational limitations
scripts/            Repository checks and offline test runner
```

There is no vendored pi agent, provider library, or terminal implementation.
The pi backend uses exact-pinned `pi-sdk`, `pi-ai`, and `pi-tui` npm aliases.
See [architecture](docs/architecture.md), [core services](packages/core/README.md),
and [desktop setup](apps/desktop/README.md).

## Development

Use Node.js 22.19 or newer.

```sh
npm install --ignore-scripts
npm run desktop
npm run preview
npm run relay -- --help
npm start -- --help
npm run check
./test.sh
```

Electron needs its separately authorized installation script; see desktop setup.
`RELAY_NODE_PATH` selects the Node executable for the desktop worker.
Codex requires an installed CLI; `RELAY_CODEX_PATH` selects it. Claude uses the
Agent SDK. Inference requires the selected backend's authentication.

`npm run check` checks formatting, dependency pins, declared runtime imports,
public dependency boundaries, TypeScript, and desktop asset/entry resolution.
`./test.sh` runs Relay's offline tests in an isolated environment without provider keys.
It does not run upstream pi tests or live inference.

## Shared conversations

```sh
npm run relay -- new --workspace /path/to/project --backend codex
npm run relay -- chat --session SESSION_ID
```

Inside chat, `/switch claude MODEL` and `/switch pi MODEL PROVIDER` select the next
runtime. `/allow ID`, `/deny ID`, and `/cancel` control execution. Runtime selection
JSON can be supplied with `--config PATH` on `new` or `switch`.

`npm start` and `npm run relay:pi` host the published pi terminal.
`--relay-session SESSION_ID` connects it to an existing Relay conversation.
In interactive mode, `/relay-switch codex`, `/relay-switch claude`, and
`/relay-switch pi MODEL PROVIDER` route subsequent prompts in the same terminal.
Pi extensions remain pi extensions; they do not execute inside Codex or Claude.

`npm run relay:service` runs the shared local service explicitly. Frontends normally
start it automatically. Data defaults to the OS application-data location for Relay.
`RELAY_DATA_DIR` changes the product root; `RELAY_APP_DIR` selects the service directory.
Credentials stay in provider profiles, outside the conversation ledger.

## Attribution

Relay originated from the pi repository and retains adapted product code.
Original MIT attribution remains in [LICENSE](LICENSE); see
[third-party notices](THIRD_PARTY_NOTICES.md). Pi is now an npm dependency.
Claude SDK has separate terms. Removing vendored source does not erase attribution
or rewrite Git history.
