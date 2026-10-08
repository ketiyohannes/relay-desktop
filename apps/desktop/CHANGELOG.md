# Changelog

## [Unreleased]

### Added

- Added Codex and Claude usage meters with remaining allowance, reset times, refresh, and Pro-specific five-hour handling.
- Added persistent Light, Dark, and System theme selection.
- Added a unified model picker across authenticated Codex/Pi and Claude accounts, with account/model selection in one action and per-profile discovery status.
- Added diff/code search including removed lines, collapsible historical file trees, safe working-file editing, full-context diffs, snapshot navigation, and visible review notes.
- Added project Git history and existing Timeline-ref browsing with recorded changes grouped beneath matching commits.

- Added a searchable session model picker backed by Pi and Claude SDK catalogs, tabbed account management, provider signup links, and validation of existing profiles.
- Added command/file summaries, partial tool output, elapsed status, and snapshot links in the conversation pane.

- Added in-app Codex and Claude subscription sign-in, isolated account profiles, authorization prompts, cancellation, and automatic account saving.

- Added a themed folder picker and searchable working-tree files, with optional Open in Finder actions.
- Added native Codex profile discovery, editable account profiles, model suggestions, and fallback ordering.
- Added account switching during a run, read-only AI snapshot reviews, line provenance, Markdown responses, and themed per-run tool approvals.

- Added an Electron coding workspace with projects, nested/recent sessions, shared provider history, account controls, streaming responses, tool activity, code snapshots, and historical review notes.
- Added persistent light and dark themes with a compact three-pane interface.
- Added a T3 Code-inspired workspace layout, collapsible project navigation, and local Phosphor icons.
- Added Timeline, Changes, Files, and Code inspector tabs, persistent resizing/collapse controls for both sidebars, and more prompt padding.

### Changed

- Replaced account and model controls with anchored dropdowns, provider labels, usage details, and searchable models across connected accounts.
- Changes and timeline file lists now preserve collapsible folder hierarchies, matching Files and snapshot browsing, with folders sorted before files.
- Automatic quota recovery validates fallback credentials and selected models, skips unavailable profiles, and preserves cross-provider session context and tool output.

- Increased text sizes, removed conversation gutters beside the inspector, and collapsed unused resize columns.

- Simplified the inspector to an underline tab bar, compact expandable timeline rows, and an on-demand snapshot picker.

### Fixed

- Handle Claude SDK subscription rejection when its stream ends or throws without a final result; preserve allowed overage, cancellation, and persistence-error behavior.
