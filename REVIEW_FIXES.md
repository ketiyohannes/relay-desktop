# Codebase review fixes

Branch: `fix/review-fixes`. Findings refer to `CODEBASE_REVIEW.md`.

| Finding | Change | Verification |
| --- | --- | --- |
| R01 | Electron single-instance ownership; desktop write lock, unique temporary files, and revision checks before conversation writes. | Independent child-process writers reject a stale save without replacing the first writer's state. |
| R02 | Byte-bounded history pages with a fixed event boundary; ordered chunk transfers for large requests, responses, and broadcasts; automatic page retrieval in the shared client. | 17 MiB Unicode output, cumulative history, desktop continuation, reconnect, CLI export, and concurrent page-boundary tests. |
| R03 | Editor lease cleanup failures record an unknown edit and remain eligible for live reconciliation. | Injected release failure after replacement; recovery and reconciliation permit a later save without restarting. |
| R04 | Execution bookkeeping clears after settlement even if final persistence fails. Initial failures start no engine; unsaved state is published with Retry saving. | Initial/final save failures, published idle/error state, retry, restart projection, and another prompt. |
| R05 | Codex outcomes use explicit error flags or structured command exit codes; missing certainty and orphan results remain unknown. | Success, failure with partial effects, misleading free text, custom tools, and orphan records; public handoff effects checked. |
| R06 | Journal envelopes and versioned payloads are validated before projection/recovery. Errors identify the journal and sequence. | Invalid statuses, nested fields, timestamps, IDs, native/approval/task/runtime records, and unknown event types; existing torn-tail repair passes. |
| R07 | Sync replacement content before rename, then sync the parent directory before completed edit evidence. | Faults at file sync, rename, directory sync, and journal completion do not acknowledge a completed edit. |
| R08 | Cached incremental projections, indexed workspace ownership checks, selective pages, and in-place event-array append. Durable append syncing is retained. | Real service append benchmark and restart comparison; unrelated ownership checks avoid full-history cloning. |
| R09 | Biome checks maintained renderer JavaScript; browser TypeScript config checks JSDoc and shared preload contracts. Generated vendor assets are excluded. | Invalid commands/response fields fail the gate; actual workspace controller tests and full renderer browser checks. |
| R10 | Atomically commit populated process locks; dead-generation recovery locks retain PID ownership; ambiguous residue gives repair guidance. | Child processes killed before ownership commit and during recovery; competing/live owners, platform-specific rename errors, and malformed-owner evidence preservation. |
| R11 | Render refreshes editor availability without resetting save errors; Save also checks busy state at invocation. | Dirty drafts survive busy/idle transitions and rejected saves; retry works in controller and real DOM checks. |
| R12 | Layout tests assert manifest, entry, and dependency structure without banning root documentation. | Full offline suite passes with the existing `docs/` directory present. |
| Q01 | Validate Glob patterns and canonical search roots/literal prefixes; Claude read-only sessions enable published `blockReadsOutsideWorkingDirectories`. | External/parent/brace/symlink patterns denied; ordinary project patterns allowed; mocked SDK query verifies native defense and hook denial. |
| Q02 | Separate query deadlines from mutation settlement. Mutations retain their request identity and promise for late replies; disconnect reports unknown completion. | Delayed mutation remains pending and receives its late result; query expiry and disconnect have distinct outcomes. |

## Verification

`npm run check` passes without errors, warnings, or infos. The isolated `./test.sh`
suite passes using Node 26.0.0: 5 tooling, 97 core, 75 desktop, and 15 renderer tests
(192 total). No build, dependency installation, lifecycle script, or paid inference
was run. The expected injected final-save error is logged by its regression test.

Full renderer checks used agent-browser against local assets with a synthetic
`window.relay` bridge. They exercised dirty editor busy transitions, rejection/retry,
approval queue and external expiry, persistence retry, pending session loads, switching,
late rejection, state replacement, and draft restoration. These checks do not exercise
actual Electron IPC or native account/provider behavior.

The real service benchmark appended 1,000 synced content events across 20 sessions,
checked workspace lookup independently of unrelated histories, and compared restart
metadata. Elapsed time, event-loop delay, and heap measurements are diagnostic rather
than production performance guarantees. Content batching was not introduced.

## Remaining verification limits

Large histories and chunk reassembly remain memory-backed. Directory sync is unavailable
on Windows, and fault injection does not prove physical power-loss durability. Lock
portability is covered through injected errors; a Windows host was not used.

Q01's gate and SDK configuration are verified offline. Native wildcard traversal through
symlinks after the first wildcard remains an integration check; no paid/native traversal
was attempted. Permission hooks are not an OS sandbox.

The review's non-finding observations about large controllers and packaging remain
documented limitations. `.npmrc` was retained; its `min-release-age` setting must not be
treated as enforced protection by npm clients that ignore it.

The original review and pre-existing user files were retained.
