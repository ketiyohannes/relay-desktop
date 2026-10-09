# Relay Desktop

Relay is a local coding workspace that shares a conversation across Codex App Server,
Claude Agent SDK, and published pi npm packages. Relay owns sessions, public history,
account selection, approvals, and recovery. Each backend owns its agent loop and tools.

## Structure

```text
src/
  main/                 Electron window, OS integration, and application worker
  preload/              Restricted IPC bridge exposed to the renderer
  renderer/             Browser UI, styles, and local icon assets
  core/
    service/            Local application service, client, protocol, and recovery
    sessions/           Durable public ledger and verified attachments
    runtimes/           Codex, Claude, and pi adapters
    desktop/            Account catalog, imports, timeline, editing, UI projections
    permissions/        Tool approval policy
    handoffs/           Bounded public context transferred between runtimes
    resources/          Workspace and configured resource ownership
    storage/            Durable file writes
    accounts/           Credential-reading helpers
    tasks/              Delegated task reports
    terminal/           Published pi terminal integration
    cli.ts              Relay CLI and JSONL RPC entry
    contracts.ts        Shared application contracts
tests/
  core/                 Offline service, runtime, and product tests
  renderer/             UI state, model grouping, and diff tests
  tooling/              Import boundaries, app layout, and dependency assets
scripts/                Development, packaging, assets, checks, and test runner
```

One application uses one package manifest, lockfile, and TypeScript configuration.
Separate workspace packages add dependency and packaging overhead without an independent
release target. The source folders still enforce process and product boundaries:
`core` cannot import Electron or the frontend, and the renderer talks through preload IPC.
The worker connects to a local service so desktop, CLI, and terminal share durable sessions.
The renderer receives account metadata; credentials remain in provider profiles.

There is no vendored pi agent, provider library, or terminal implementation. The pi
adapter uses exact-pinned `pi-sdk`, `pi-ai`, and `pi-tui` npm aliases and their public exports.

## Development

Use Node.js 22.19 or newer:

```sh
npm install --ignore-scripts
npm start
```

Electron's executable must already be installed. On a fresh install, explicitly authorize
and run `node node_modules/electron/install.js` separately. Launching Relay never runs
that installation script implicitly.

Commands run from the repository root:

| Command | Purpose |
| --- | --- |
| `npm start` | Launch the desktop app |
| `npm run preview` | Serve the browser-only UI at `http://127.0.0.1:4318` |
| `npm run build:desktop` | Package Relay Desktop for the host macOS architecture |
| `npm run icons` | Regenerate the selected Phosphor SVG assets |
| `npm run check` | Format/lint, type-check, validate imports and pins, resolve app entries |
| `./test.sh` | Run all offline Relay tests with isolated data and no provider keys |
| `npm run relay -- --help` | Show CLI commands |
| `npm run relay:pi -- --help` | Host the published pi terminal |
| `npm run relay:service` | Start the shared local service explicitly |

The preview has no filesystem or runtime connection. Tests use fake native backends,
temporary repositories, and pi's faux provider; they do not send paid inference requests.
Focused tests: `node --test tests/core/application.test.ts`,
`node node_modules/vitest/dist/cli.js --run tests/core/desktop/permissions.test.ts`,
or `node --test tests/renderer/code-view.test.mjs`.

`RELAY_NODE_PATH` selects the worker's Node executable. `RELAY_CODEX_PATH` selects the
installed Codex CLI. `RELAY_DATA_DIR` overrides the application data root and
`RELAY_APP_DIR` overrides the service directory. Default desktop data is the OS
application-data directory's `Relay` folder; service data is `Relay/sessions/app`.

The macOS package includes production dependencies and official Node 26.0.0, checked
against its release SHA-256 manifest. Dependency installation disables lifecycle scripts.
Output is `dist/relay-desktop-<version>-darwin-<arch>/Relay Desktop.app`.
The build uses a local ad-hoc signature; public distribution requires Developer ID
signing and Apple notarization. Codex still uses the user's installed CLI.

## Sessions and accounts

Connect Codex/Claude subscriptions with the Accounts sign-in flow, or select existing
native provider profiles. Repeated logins with the same identifiable provider account
reuse one account entry. Models appear once per provider, regardless of account count;
selection uses an eligible account and preserves the current account when possible.
Confirmed quota exhaustion can switch to another configured account after execution
settles. Authentication errors and generic rate limits do not trigger rotation.

Native Codex and Claude conversations appear through local metadata discovery. Opening
one imports its supported public history into Relay; the original transcript remains
unchanged. Continuing creates a Relay-managed native conversation. Imports do not copy
private reasoning, subagent threads, native permissions, or historical file snapshots.
Relay handoff wrappers and automatic continuation prompts are hidden from chat.

Switching runtimes transfers bounded public conversation, completed outcomes, artifacts,
and task state. Completed effects remain evidence; Relay does not replay their tool
calls. Native transcripts, credentials, and compaction remain backend-owned.

Permission modes are saved per session:

| Mode | Behavior |
| --- | --- |
| Ask | Present native approval requests and gate Claude/pi tools |
| Approve for me | Use Codex/Claude native risk review; unresolved requests still ask. Pi allows known reads/file edits and asks for shell/unknown tools |
| Full access | Skip Relay approvals, disable Codex sandboxing, and use Claude's native permission bypass |
| Readonly | Allow supported project reads; deny writes and shell execution |

Claude/pi tool hooks are not OS sandboxes. Trusted extensions, project hooks, and remote
MCP servers execute under their own environment. Snapshot reviews use stricter policies.
Timeline is optional, off by default, and uses hidden Git refs without changing HEAD,
the user's index, or working files. Native tool notifications are asynchronous, so
snapshots describe observed states rather than guaranteed barriers before each tool.

## CLI and recovery

```sh
npm run relay -- new --workspace /path/to/project --backend codex
npm run relay -- chat --session SESSION_ID
```

Chat supports `/switch BACKEND MODEL [PROVIDER]`, `/allow ID`, `/deny ID`, and `/cancel`.
The pi terminal supports `--relay-session SESSION_ID`, `/relay-switch`, and `/relay-cancel`.
Pi extensions remain inside pi. Codex/Claude noninteractive requests use Relay CLI/RPC;
pi's own RPC protocol remains separate.

The local service authenticates clients over a private Unix socket or Windows pipe.
It stores `ledger/`, `native/`, `artifacts/`, and `resources/`, plus its token and lock.
Ledger writes are serialized and synced. A torn final record is backed up and repaired;
malformed complete records fail visibly. The service is a local single writer.

Cancellation requests are distinct from verified settlement. Lost connections or tool
starts without outcomes retain workspace ownership and stop automatic continuation.
Inspect native processes and partial effects before recording reconciliation:

```sh
npm run relay -- reconcile --session SESSION_ID --turn TURN_ID --description "execution stopped; effects inspected"
npm run relay -- reset --session SESSION_ID --description "native record missing; retain public history"
```

Use `--turn edit:OPERATION_ID` for uncertain editor saves. Reconcile parent and child
unknown turns individually. Reset retains the public conversation and starts fresh
native mappings on the next turn. Resource ownership is cooperative; it cannot fence
unrelated or remote processes. Windows process settlement remains conservative.

Configured native specialists use `workers.json` in the service directory. They require
installed/authenticated runtimes and explicit resource/MCP configuration. Relay supplies
no browser broker or remote process environment. Commands must reference credentials
through environment variable names or profiles, never durable command arguments.

Very large histories remain limited by in-memory projections and 16 MiB transport frames.
Offline checks validate app wiring and behavior, not live subscriptions or native inference.
Report reproducible security boundary bypasses privately to the maintainer without
credentials or private transcripts.

Development rules are in [AGENTS.md](AGENTS.md). Required attribution for adapted code
and dependency assets remains in [LICENSE](LICENSE) and [NOTICE](NOTICE).
