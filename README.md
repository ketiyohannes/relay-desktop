# Relay Desktop

Relay is a local coding workspace that shares a conversation across Codex App Server,
Claude Agent SDK, and published pi npm packages. Relay owns sessions, public history,
account selection, approvals, and recovery. Each backend owns its agent loop and tools.

## Structure

```text
src/
  main/                 Electron window, OS integration, and application worker
  preload/              Restricted IPC bridge exposed to the renderer
  renderer/
    app.js              Connects state, bridge events, and built-in features
    features/           Accounts, conversation, imports, permissions, reviews,
                        sessions, settings, timeline, and workspace UI
    shell/              Panel layout, resizing, notices, and responsive styles
    ui/                 Shared DOM, Markdown, code, tree, and select controls
    styles/             Theme and base styles; feature CSS lives with its UI
    icons/              Local icon assets
  core/
    service/            Application coordination, socket server/client, protocol
    sessions/           Public ledger, execution, recovery, conversation runner,
                        session commands, projections, and verified attachments
    runtimes/           Codex, Claude, and pi adapters
    desktop/            Command routing, shared-service connection, persistence,
                        state projection, and incremental UI updates
    permissions/        Tool policy, approval lifecycle, and approval presentation
    handoffs/           Bounded public context transferred between runtimes
    resources/          Workspace and configured resource ownership
    storage/            Durable file writes
    accounts/           Profiles, catalogs, login, usage, selection, and credentials
    imports/            Native session discovery, public transcript import
    timeline/           Snapshots, history, change filtering, and queries
    workspace/          Browsing, search, file reads, and durable editor saves
    reviews/            Snapshot review context and isolated review environment
    tasks/              Delegation, worker configuration, and task reports
    terminal/           Published pi terminal integration
    cli.ts              Relay CLI and JSONL RPC entry
    contracts.ts        Public type exports; definitions live with their owners
tests/
  core/                 Offline service, runtime, and product tests
  renderer/             UI state, model grouping, and diff tests
  tooling/              Import boundaries, app layout, and dependency assets
scripts/                Development, packaging, assets, checks, and test runner
```

One application uses one package manifest and lockfile. TypeScript checks core/process
code and maintained renderer JavaScript through separate Node and browser configurations.
Separate workspace packages add dependency and packaging overhead without an independent
release target. The source folders still enforce process and product boundaries:
`core` cannot import Electron or the frontend, and the renderer talks through preload IPC.
The worker connects to a local service so desktop, CLI, and terminal share durable sessions.
The renderer receives account metadata; credentials remain in provider profiles.

Features are built-in modules with explicit dependencies. A workspace save, for
example, goes from the renderer editor through preload IPC to the desktop router,
then to workspace code; it does not require changing account or import code.
Each module owns its timers, caches, and request state. Entry files connect modules
through named callbacks and typed interfaces. The checks enforce core/process
separation and require UI features to use another feature's entry point.
See [ARCHITECTURE.md](ARCHITECTURE.md) for file responsibilities and extension rules.

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
| `npm run check` | Format/lint maintained source, type-check core and renderer bridge contracts, validate imports and pins, resolve app entries |
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
Codex imported tool outcomes require explicit native error flags or structured command
exit codes. Outputs without reliable status appear as Outcome unknown; their text is
retained. Failed tools may have partial effects and remain uncertain in public handoffs.

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
The desktop also runs as one instance per data directory. Shared desktop saves acquire
a process lock and reject stale index revisions before writing conversation files.
Dead process locks are recovered using their recorded ownership. If ownership cannot
be established, startup names the lock directory to move aside after stopping all Relay
processes; keep session journals in place.

Editor saves sync replacement content before rename and sync the parent directory
before recording completion. Directory sync is unavailable on Windows. Failed file
durability or lease cleanup retains an uncertain edit for inspection and reconciliation.
When execution settles but desktop persistence fails, the UI reports unsaved state and
offers Retry saving. A successful retry clears the error without restarting execution.

Desktop queries have a deadline. Mutating commands remain pending after the deadline
and deliver late replies; a worker disconnect reports their completion as unknown.
Inspect state and effects before retrying an operation with an unknown result.

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

History retrieval uses bounded pages with a fixed event boundary. Messages larger than
the 16 MiB wire frame limit use ordered chunks with socket backpressure, including tool
broadcasts and imports. Very large histories remain limited by in-memory projections
and complete-message reassembly. Each journal append is still synced before acknowledgment.
Offline checks validate app wiring and behavior, not live subscriptions or native inference.
Report reproducible security boundary bypasses privately to the maintainer without
credentials or private transcripts.

Development rules are in [AGENTS.md](AGENTS.md). Required attribution for adapted code
and dependency assets remains in [LICENSE](LICENSE) and [NOTICE](NOTICE).
