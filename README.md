# Relay Desktop

A minimal fork of [Pi](https://github.com/earendil-works/pi), retaining its local coding-agent core. No desktop shell has been added yet.

| Package | Purpose |
| --- | --- |
| `packages/ai` | Model providers, authentication, streaming, and shared message types. |
| `packages/agent` | Agent loop, conversation state, and tool execution. |
| `packages/coding-agent` | CLI, coding tools, sessions, and extension API. |
| `packages/tui` | Interactive terminal interface and rendering. |

Removed: experimental client/server/protocol and durable runtimes, Chord, telemetry package, evals, MCP, codemode, and all built-in extensions. The extension API remains available for future additions.

## Development

Requires Node.js 22.19 or newer.

```sh
npm install --ignore-scripts
npm run hydrate:model-data
npm start -- --help
npm start
npm run check
```

`npm start` runs TypeScript directly using the retained workspace source resolver. Model catalog hydration is needed before normal startup; a fresh clone does not contain generated provider JSON.

The application command and configuration remain `pi` and `~/.pi/agent` for now. Default tools are `read`, `bash`, `edit`, and `write`. Interactive, print, JSON, and RPC modes and session persistence remain intact.

The root scripts retain a build pipeline for the four packages. `./test.sh` runs tests in an isolated environment without API credentials.

## Origin and license

Forked from `earendil-works/pi` at `4c6fb7cfe`. Original authorship and the MIT license are preserved in `LICENSE` and package metadata. `origin` points to Relay Desktop; `upstream` points to Pi.
