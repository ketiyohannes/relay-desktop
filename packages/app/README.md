# Relay application services

This private workspace owns product sessions and execution coordination. It imports published pi entry points through npm aliases and never imports the local fork. Native runtimes own requests, tools, compaction, and native transcripts.

## Commands

From the repository root:

```sh
npm run relay -- --help
npm run relay:service
npm run relay:pi -- --relay-session SESSION_ID --profile /path/to/pi/profile
```

The service starts automatically when a frontend connects. It is local, with a private token and Unix socket or Windows pipe; it is not a remote multi-user server. Closing a frontend disconnects its owned active turns. Durable records do not require keeping runtimes alive between turns.

The native CLI supports `new`, `list`, `show`, `switch`, `chat`, `prompt`, `cancel`, `reset`, `reconcile`, `export`, and versioned JSONL `rpc`. Native RPC uses Relay commands/events. The published-pi terminal's `--mode rpc` retains pi's protocol; these are separate integration surfaces.

`relay chat` replays saved public history and supports `/switch BACKEND MODEL [PROVIDER]`. Desktop switches by account/model in the same conversation. The default rich terminal (`npm start`) routes subsequent interactive input to the selected backend after `/relay-switch codex|claude|pi MODEL [PROVIDER]`. Native streaming appears in a temporary widget and is then retained as public display history. Restart replays missing public history without duplicating messages already shown in its native journal. `/relay-cancel` and the configurable `app.interrupt` binding cancel native work; Escape is the default. Pi retains its own steering/follow-up controls; equivalent steering into a running Codex/Claude turn is not implemented.

Print/JSON/pi RPC modes require a pi selection. A noninteractive `--relay-session` with Codex/Claude selected fails explicitly; use `relay prompt` or Relay RPC instead. Native rich-terminal display messages are excluded from pi's model context; the service supplies their public evidence through handoffs when pi continues.

Published-pi flags include sessions, forks, print/JSON/RPC, tools, extensions, skills, prompts, themes, project trust, attachments, and context settings. New/fork/tree navigation creates or resolves Relay lineage and imports only the selected public branch. Managed images and handoff artifacts are copied into branch storage; external artifact references retain their original locations and availability limits. Extension providers register before model lookup. Project trust uses public loader callbacks and `ProjectTrustStore`; remembered denials override the default trust setting, and unresolved noninteractive trust is denied. Auth/config/package commands delegate to public pi `main()`. No local model-catalog hydration is needed for this path. Removed builtins (`mcp`, `codemode`, `tool-search`, `llama.cpp`) are disabled, and terminal telemetry is disabled. The published dependencies still contain their upstream transitive packages.

## Durable state

Default service data is `Relay/sessions/app` under the OS data directory. `RELAY_APP_DIR` overrides it; `RELAY_DATA_DIR` overrides the product root. Desktop explicitly passes the shared service path to its worker. An isolated test/QA directory isolates its registry.

```text
app/
  ledger/SESSION_ID.jsonl   # Relay public history and execution metadata
  native/RECORD_ID/         # pi journals; opaque to Relay
  artifacts/SESSION_ID/     # verified content-addressed attachments
  resources/HASH/owner.json # durable ownership/quarantine
  workers.json             # explicitly configured native specialists
  service.token            # local frontend authentication
  service.lock/owner.json
```

Claude/Codex native persistence remains in their selected provider profiles. Workspace files, Git timeline refs, and browser state are separate from all transcripts. Desktop `state.json` is a UI projection and account catalog; public imports and product notes are mirrored to the global ledger. Desktop settings and unsaved editor buffers are frontend state.

Every ledger append is serialized and synced before the next controlled tool boundary. A torn final JSONL line is backed up and truncated; malformed complete records fail visibly. No database, remote service, or work queue is required for one local service writer. The current in-memory projection and 16 MiB transport frames limit very large conversations; journals can still be inspected/exported from disk.

The published terminal's `--no-session` creates an ephemeral conversation and in-memory pi journal. Public text, prompts, handoffs, and tool content are omitted from its durable recovery journal. Minimal workspace, selection, operation, approval, and task identities/statuses survive a crash. Quarantined recovery metadata is retained until reconciliation; idle metadata is deleted. This is not a promise of zero filesystem metadata or zero native/browser side effects.

## Delegation

Create `workers.json` in the service directory before starting it. Configure only infrastructure you have installed and authenticated:

```json
[
  {
    "id": "browser-specialist",
    "description": "Read web policies and return sources and evidence",
    "selection": {
      "backend": "claude",
      "profile": "/path/to/claude/profile",
      "model": "",
      "options": {
        "mcp": {
          "browser": {
            "command": "/absolute/path/to/reviewed-browser-mcp-server",
            "args": [],
            "envKeys": ["BROWSER_TOKEN"]
          }
        }
      }
    },
    "resource": "browser:personal"
  }
]
```

This explicitly introduces MCP for native workers; it does not restore fork-wide pi MCP. Relay supplies no browser process, desktop environment, browser MCP server, or managed browser broker. The server command/arguments are durable configuration, so credentials must be supplied through environment variable names or native profiles, never command arguments. Restart the service after changing worker profiles; there is no hot reload.

Pi exposes `relay_delegate_task({workerId, objective})`. The model cannot choose profiles, processes, resource identities, or permission overrides. Relay suspends the parent turn, creates a linked worker native record, acquires the shared resource, collects structured findings/evidence/effects/blockers, and returns the result before the parent continues. Worker messages do not become parent messages or change its active backend.

The default is one writer per canonical workspace and one worker per parent turn. Shared browser/desktop resources are serialized by identity. These are cooperative ownership rules, not process isolation or remote tool fencing. Detached processes and remote automation require separate infrastructure capable of proving settlement. Read-only Claude workers allow Read/Grep/Glob and reject MCP tools; browser navigation in that mode is currently unsupported.

## Approvals and recovery

Relay approval IDs map to one native record and turn/task. Desktop offers Allow once, Allow for this run, or Deny; run allowance is scoped to the session and turn. Native CLI/RPC routes decisions explicitly. Pending approvals expire after two minutes, become blocked worker status, and are closed on cancellation/restart. Multiple frontends cannot concurrently send conflicting decisions through the normal response path.

Codex uses native approval policy and sandboxing. Claude/pi use per-tool hooks; a dialog or hook is not an OS sandbox. Trusted pi extensions and Claude project hooks run code and remain outside that boundary. Read-only tool checks validate paths but cannot make arbitrary trusted extensions safe. Native policies differ; unsupported requests are errors/denials, not successful enforcement.

Cancellation is a request until the backend settles. Interrupted tool starts without matching outcomes, lost connections, and unverified process groups quarantine execution and retain resource ownership. Service cancellation and release waits have a bounded settlement deadline; uncooperative SDKs/extensions become unknown, and late observations are rejected. This does not prove those processes stopped. Windows process-subtree settlement is conservatively unknown. Uncertain snapshot-review exports remain on disk with their location recorded; manual account switching does not start a replacement worker after an uncertain result.

Native CLI `--attach PATH` captures images or text as verified session attachments. Image-capable pi models receive native image blocks; text-only models fail before inference. Codex/Claude use their native image input formats. Handoffs carry artifact references rather than automatically submitting every prior image to the new model. Native read tools can retrieve a filtered public history file and explicitly allowed attachment paths; credential profiles and backend journals are outside that read allowance.

After restart, interrupted turns/tasks become `unknown` and pending approvals become `interrupted`. No prompt, completed command, click, edit, or submission is retried automatically. Inspect native processes, browser/desktop state, and partial file effects, then record verification:

```sh
npm run relay -- reconcile --session SESSION_ID --turn TURN_ID --description "verified native execution stopped and effects inspected"
npm run relay -- reset --session SESSION_ID --description "native session missing; retain public history"
```

Use `--turn edit:OPERATION_ID` for uncertain editor saves. Reconcile child and parent unknown turns individually. Reconciliation is an operator assertion, not an automated proof that a remote browser is idle. `reset` opens fresh native mappings on subsequent turns while retaining the Relay conversation.

## Validation

Run `npm run check` from the root. Focused offline application tests:

```sh
cd packages/app
node --test test/application.test.ts test/adapters.test.ts test/pi.test.ts test/desktop.test.ts test/desktop-product.test.ts test/hosted.test.ts test/protocol.test.ts test/process-group.test.ts test/terminal-sessions.test.ts test/approvals.test.ts test/attachments.test.ts test/native-terminal.test.ts test/trust.test.ts
node --test test/service.test.ts test/terminal.test.ts test/cli.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/desktop/accounts.test.ts test/desktop/explorer.test.ts test/desktop/login.test.ts test/desktop/permissions.test.ts test/desktop/session-import.test.ts test/desktop/timeline-options.test.ts test/desktop/usage.test.ts
```

The second command binds local sockets. Tests use mocked native backends, public pi's faux provider, and temporary files/Git repositories. The migrated desktop tests exercise the extracted product modules, with fake login/catalog/metadata transports and a synthetic Codex CLI. They do not use provider credentials or paid inference. The focused verification passed 54 application/boundary tests and 63 desktop tests. Builds, the full test suite, live inference, and native Electron QA are not part of this migration validation.

See the [migration matrix](../../docs/native-runtime-migration.md) for remaining preservation and retirement gates.
