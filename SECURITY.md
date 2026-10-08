# Relay security

Relay runs locally and coordinates coding runtimes that can read or modify workspace
files and execute tools. Use trusted profiles, extensions, project hooks, and MCP servers.
Contain execution with the selected backend's sandbox or separate OS isolation when needed.

The application service authenticates local clients with a private token over a Unix
socket or Windows pipe. It is not a remote multi-user service. Credentials remain in
native provider profiles, outside the renderer and public ledger. Public tool input/output
can still contain sensitive data; do not assume automatic secret removal.

Codex uses its native sandbox and approval policy. Claude/pi permission hooks and UI
dialogs are not OS isolation. Cooperative workspace leases cannot fence unrelated or
remote processes. Interrupted or uncertain execution retains ownership until inspected
and reconciled; cancellation alone does not prove tools stopped.

See `docs/architecture.md` and `packages/core/README.md` for current limits.

Report reproducible boundary bypasses privately through this repository's security
reporting channel if enabled, or contact its maintainer privately. Include the affected
revision, runtime/profile configuration, reproduction steps, and observed impact.
Do not send credentials or private transcripts. This repository is not operated by
pi's upstream maintainers; upstream runtime vulnerabilities belong to that runtime.
