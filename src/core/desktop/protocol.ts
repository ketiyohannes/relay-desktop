import type { AccountCatalog, AccountCatalogs, AccountUsage, DesktopAccount } from "../accounts/types.ts";
import type { ExternalSessionPreview, ExternalSessions } from "../imports/types.ts";
import type { RecoveryEntry } from "../sessions/types.ts";
import type { ProjectHistory, SnapshotView } from "../timeline/types.ts";
import type { CodeSearchResult, DirectoryView, EditorFile } from "../workspace/types.ts";
import type { DesktopState } from "./types.ts";

export type DesktopCommand =
	| { type: "retry_save" }
	| { type: "recovery"; sessionId: string }
	| { type: "reconcile"; sessionId: string; turnId: string; description: string }
	| { type: "refresh_sessions"; force?: boolean }
	| { type: "session_load"; sessionId: string }
	| { type: "timeline_status"; sessionId: string }
	| { type: "timeline_enable"; sessionId: string; enabled: boolean }
	| { type: "session_permissions"; sessionId: string; mode: "ask" | "auto-approve" | "full-access" | "read-only" }
	| { type: "external_sessions"; provider: "codex" | "claude"; path?: string }
	| { type: "external_preview"; sourceId: string }
	| { type: "import_session"; sourceId: string; project?: string }
	| { type: "session_project"; sessionId: string; project: string }
	| { type: "login_start"; provider: "codex" | "claude"; name: string }
	| { type: "login_reply"; id: string; value: string }
	| { type: "login_cancel" }
	| { type: "state" }
	| { type: "browse"; path?: string }
	| { type: "workspace"; sessionId: string; path?: string }
	| { type: "history"; sessionId: string }
	| { type: "search_code"; sessionId: string; actionId?: string; query: string; scope: "diff" | "code"; path?: string }
	| { type: "editor_read"; sessionId: string; path: string; actionId?: string }
	| { type: "editor_save"; sessionId: string; path: string; expected: string; content: string }
	| { type: "catalog"; configDir?: string; credentialSource?: "pi" | "codex"; engine?: "pi" | "claude" }
	| { type: "account_catalog"; accountId: string }
	| { type: "account_catalogs"; refresh?: boolean }
	| { type: "account_usage"; accountId: string; refresh?: boolean }
	| { type: "select_model"; sessionId: string; accountId: string; model: string }
	| { type: "project"; path: string }
	| { type: "session"; project: string }
	| { type: "account"; account: DesktopAccount }
	| { type: "move_account"; accountId: string; offset: -1 | 1 }
	| { type: "select_account"; sessionId: string; accountId: string; autoSwitch: boolean }
	| { type: "prompt"; sessionId: string; text: string }
	| { type: "cancel" }
	| { type: "snapshot"; sessionId: string; actionId: string; path?: string }
	| { type: "review"; sessionId: string; actionId: string; text: string }
	| { type: "review_snapshot"; sessionId: string; actionId: string };

export type DesktopResult =
	| { recovery: RecoveryEntry[] }
	| { timeline: { supported: boolean; enabled: boolean } }
	| ExternalSessions
	| ExternalSessionPreview
	| { importedSessionId: string }
	| DesktopState
	| SnapshotView
	| DirectoryView
	| AccountCatalog
	| AccountCatalogs
	| AccountUsage
	| ProjectHistory
	| CodeSearchResult
	| EditorFile;
