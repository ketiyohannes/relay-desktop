# Relay

Relay provides a shared workspace and durable conversation across Codex App Server, Claude Agent SDK, and published pi packages. Desktop and the new CLI use one local application service. Each backend owns its agent loop.

Desktop, the default terminal (`npm start`), and the native CLI use the application layer. The legacy CLI remains available as `npm run start:legacy` while the remaining preservation and source-retirement gates are completed. See the [migration status and feature matrix](docs/native-runtime-migration.md).

| Package | Role |
| --- | --- |
| `packages/app` | Global sessions, ledger, runtime adapters, approvals, delegation, CLI, and desktop product services. |
| `packages/desktop` | Electron shell and workspace UI. |
| `packages/ai`, `agent`, `coding-agent`, `tui` | Legacy fork retained during the preservation transition. New application code cannot import it. |

Use Node.js 22.19 or newer; validation on this machine uses `/opt/homebrew/bin/node` 26.0.0.

```sh
npm install --ignore-scripts
npm start -- --help
npm run relay -- --help
npm run relay:pi -- --help
npm run desktop
npm run check
```

Electron needs its separately authorized installation script; see [desktop setup](packages/desktop/README.md). Codex execution requires an installed Codex CLI; `RELAY_CODEX_PATH` selects it. Claude uses the pinned Agent SDK. Inference requires the selected backend's authentication.

Start a shared session and continue in the same CLI conversation:

```sh
npm run relay -- new --workspace /path/to/project --backend codex
npm run relay -- chat --session SESSION_ID
```

Inside chat, `/switch claude MODEL` and `/switch pi MODEL PROVIDER` select the next runtime. `/allow ID`, `/deny ID`, and `/cancel` control execution. Model/profile choices can also be supplied by a runtime-selection JSON file using `--config PATH` on `new` or `switch`.

`npm start` (also `npm run relay:pi`) hosts the published pi terminal, extension API, print/JSON/RPC modes, and native session navigation. `--relay-session SESSION_ID` connects it to an existing Relay conversation. In interactive mode, `/relay-switch codex`, `/relay-switch claude`, and `/relay-switch pi MODEL PROVIDER` route subsequent prompts in the same terminal. Rich terminal extensions belong to pi and do not become Claude or Codex extensions. The [application README](packages/app/README.md) documents persistence, worker setup, recovery, and limitations.

The default application directory is the OS data location for Relay. `RELAY_DATA_DIR` changes the product data root; `RELAY_APP_DIR` selects the session service directory directly. Frontends with the same application directory share the registry. Credentials remain in provider profiles, outside the conversation ledger.

The legacy command uses the local source resolver and may need `npm run hydrate:model-data`. No application code uses its provider or agent-loop implementation. The root build pipeline and `./test.sh` currently still cover the retained workspaces; source retirement remains separate from the application cutover.

Fork origin: `earendil-works/pi` at `4c6fb7cfe`. Original authorship and MIT licensing remain in `LICENSE` and package metadata. Published pi dependencies declare MIT licensing; Claude SDK has separate terms. See [dependency provenance](docs/native-runtime-migration.md#dependencies-and-verified-apis).
