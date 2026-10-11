# Module ownership

Relay has four execution environments. `core` contains shared application behavior;
`main` owns Electron and OS integration; `preload` exposes the restricted bridge;
`renderer` owns browser UI. An execution environment defines what a file can access:
the renderer cannot read a provider profile, and core cannot open an Electron window.

Built-in features are ordinary source modules. There is no loader, registry, or
independent package release. The application connects modules explicitly, so a
developer can follow a command from the UI to its implementation.

## Shared application

| Folder | Main files and responsibilities |
| --- | --- |
| `core/service` | `application.ts` connects durable sessions, execution, approvals, recovery, and delegation. `server.ts`, `client.ts`, `protocol.ts`, and `hosted.ts` handle service transport and frontend-hosted runtimes. |
| `core/runtimes` | `types.ts` defines native adapter contracts. `codex/`, `claude/`, and `pi/` implement provider-specific loops through published APIs. |
| `core/sessions` | `ledger.ts` persists public history; `execution.ts` owns native execution/settlement; `recovery.ts` owns uncertainty and reconciliation; `conversation-runner.ts` owns desktop run attempts and account switching; `commands.ts` owns project/session mutations; `desktop-projection.ts` translates ledger events for desktop views. |
| `core/accounts` | `accounts.ts` owns profile validation, catalog caching, and serialized saves; `commands.ts` handles login, account/model selection, ordering, and catalog/usage requests; `catalog.ts`, `login.ts`, `usage.ts`, `identity.ts`, and `selection.ts` own their respective behavior. Credential helpers remain here. |
| `core/permissions` | `gate.ts` applies policy; `approvals.ts` owns live approvals and expiration; `presenter.ts` displays each approval once across frontend refreshes. |
| `core/imports` | `discovery.ts` reads native metadata/transcripts; `import-session.ts` owns import queues and source mapping; `presentation.ts` filters visible public text. |
| `core/timeline` | `snapshots.ts` records and reads hidden Git refs; `history.ts` groups project history; `actions.ts` locates snapshot actions; `commands.ts` handles timeline/snapshot queries and opt-in changes; `change-filter.ts` excludes irrelevant paths. |
| `core/workspace` | `browse.ts` lists folders; `files.ts` reads workspace/editor views; `search.ts` searches code/diffs; `save-file.ts` replaces files durably; `edits.ts` records edits under a workspace lease; `commands.ts` connects desktop requests to these operations. |
| `core/reviews` | `context.ts` prepares bounded snapshot context and an immutable review directory. Execution and account-switch behavior use the shared conversation runner. |
| `core/tasks` | `delegation.ts` owns delegated execution and resource ownership; `workers.ts` validates worker configuration; `report.ts` validates structured results. |
| `core/desktop` | `commands.ts` routes requests and connects modules; `service-connection.ts` connects to the shared application; `state.ts` projects visible state; `updates.ts` batches stream/persistence updates; `store.ts` persists the desktop index; `requests.ts` tracks IPC deadlines. |
| `core/handoffs`, `resources`, `storage`, `terminal` | Bounded public handoff evidence, shared resource leases, durable writes, and published pi terminal integration. |

Types live in their owning folder's `types.ts`. `core/contracts.ts` aggregates the
public types for the core entry point. Shared behavior may use desktop projection
types, but cannot import the desktop controller or connection implementation.

## Browser UI

`renderer/app.js` receives bridge state, selects the active session, and connects
feature callbacks. It does not own feature caches or form submission state.

| Folder | Files and ownership |
| --- | --- |
| `features/accounts` | `index.js` connects account settings, sign-in, profile forms, and usage controls; `account-picker.js` owns account/usage popovers; `model-picker.js` owns model requests; `model-options.js` groups eligible models. |
| `features/conversation` | `messages.js` renders visible messages/tools and owns presentation caches and scroll state; `composer.js` owns drafts and pending submissions; `stream-state.js` merges incremental updates. |
| `features/sessions` | `index.js` renders project groups, recent sessions, search results, and the active session header. |
| `features/imports` | `index.js` owns source selection, preview requests, and import actions. |
| `features/permissions` | `index.js` owns approval dialogs, queue settlement, and permission selection. |
| `features/reviews` | `index.js` renders reviews and submits human/agent review requests through the bridge. |
| `features/timeline` | `index.js` renders session entries/previews; `history.js` owns support checks, opt-in state, project history, and navigation; `snapshot-dialog.js` owns snapshot/file selection, stale-request tokens, and origin navigation. |
| `features/workspace` | `index.js` connects workspace tools; `editor.js` owns drafts/save state; `search.js` owns search requests; `explorer.js` owns inspector tabs/files; `folder-picker.js` returns selected folders to application wiring. |
| `features/settings` | `index.js` owns preferences, shortcut matching, and settings navigation. |
| `shell`, `ui`, `styles` | Application layout/notices, shared DOM/Markdown/code/tree/select controls, and base/theme styles. |

Features receive named callbacks and typed command functions. They return only the
operations the application needs. Cross-feature runtime imports go through
`index.js`; composition in `app.js` may connect individual modules directly.
Feature request tokens, timers, and caches stay inside the module that owns them.

CSS lives beside the relevant UI. `renderer/style.css` imports contiguous style
sections in the original order, preserving the cascade and existing appearance.

## Adding or debugging a feature

1. Put shared behavior and types under its owning `core` folder. Add browser behavior
   under `renderer/features/<name>`. Add Electron-only operations under `main` and
   expose only required capabilities through `preload`.
2. Define command inputs/results in `core/desktop/protocol.ts` and
   `core/desktop/bridge.ts` when the feature needs desktop IPC. Route the command
   explicitly in `core/desktop/commands.ts`.
3. Pass the module only the dependencies it uses. Connect feature interactions in
   application wiring instead of importing another feature's private state.
4. Add behavior tests under the relevant test category. Nested tests are discovered
   by `scripts/test.mjs`. Desktop Vitest tests stay under `tests/core/desktop`; Node
   tests stay in the other offline categories. Paid/provider suites belong outside
   those categories and are not run by `test.sh`.
5. Run `npm run check` and `./test.sh`. The check verifies types, dependency pins,
   import boundaries, browser assets/styles, and Electron entry resolution.

For a broken editor save, follow `features/workspace/editor.js` → preload bridge →
`core/desktop/commands.ts` → `core/workspace/commands.ts` → service edit/file save.
Account switching lives in `core/sessions/conversation-runner.ts`; native settlement
lives in `core/sessions/execution.ts`. These are separate because switching must wait
for the previous runtime's effects to settle before starting another attempt.
