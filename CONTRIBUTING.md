# Contributing

Relay contains `apps/desktop` and `packages/core`. Put operating-system/UI integration
in the desktop app and shared product/runtime behavior in core. Integrate pi through
published public APIs; do not copy its provider, agent, or terminal implementation.

Install with `npm install --ignore-scripts`. Run `npm run check` after code changes
and `./test.sh` for offline regressions. Direct external dependencies use exact pins.
Review package/lockfile changes and lifecycle scripts. Do not run installation scripts,
live provider calls, or create commits without user authorization.

Preserve attribution for adapted code and third-party assets. See `AGENTS.md` for the
development rules and `docs/architecture.md` for ownership and limitations.
