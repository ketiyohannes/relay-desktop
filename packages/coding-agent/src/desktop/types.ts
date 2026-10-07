export interface DesktopAccount {
	id: string;
	name: string;
	engine: "claude" | "pi";
	/** Isolated managed profile or existing authenticated provider directory. */
	configDir: string;
	provider: string;
	model: string;
	credentialSource?: "pi" | "codex";
}

export interface DesktopAction {
	id: string;
	time: number;
	kind: "user" | "assistant" | "tool" | "switch" | "error" | "checkpoint" | "review";
	text: string;
	toolId?: string;
	status?: "running" | "done" | "error";
	input?: string;
	output?: string;
	progress?: string;
	finished?: number;
	snapshot?: string;
	previous?: string;
	files?: string[];
	/** A Git root commit is a change from an empty tree, unlike a session baseline. */
	rootCommit?: boolean;
	changeOrder?: number;
}

export interface DesktopSession {
	id: string;
	project: string;
	name: string;
	updated: number;
	accountId: string;
	/** Session selections keyed by account; account defaults remain unchanged. */
	models?: Record<string, string>;
	autoSwitch: boolean;
	lastEngine?: string;
	claudeSessionId?: string;
	actions: DesktopAction[];
}

export interface DesktopState {
	projects: string[];
	sessions: DesktopSession[];
	accounts: DesktopAccount[];
	busySession?: string;
}

export type DesktopCommand =
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
	| { type: "account_catalogs" }
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

export interface DesktopLogin {
	status: "running" | "success" | "error" | "cancelled";
	message: string;
	url?: string;
	code?: string;
	prompt?: {
		id: string;
		type: "text" | "secret" | "manual_code" | "select";
		message: string;
		options?: readonly { id: string; label: string; description?: string }[];
	};
}

export interface DirectoryView {
	path: string;
	parent: string;
	entries: { name: string; path: string; directory: boolean }[];
}

export interface AccountCatalog {
	configDir: string;
	connected?: boolean;
	identity?: string;
	models: {
		provider: string;
		id: string;
		name: string;
		authenticated: boolean;
		description?: string;
		contextWindow?: number;
	}[];
}

export interface AccountCatalogs {
	accounts: { accountId: string; catalog?: AccountCatalog; error?: string }[];
}

export interface AccountUsage {
	accountId: string;
	status: "available" | "unavailable" | "unsupported";
	checkedAt: number;
	plan?: string;
	message?: string;
	noFiveHourLimit?: boolean;
	windows: { id: string; label: string; remainingPercent: number | null; resetsAt?: number }[];
}

export interface HistoryGroup {
	id: string;
	text: string;
	action?: DesktopAction;
	events: DesktopAction[];
}
export interface ProjectHistory {
	groups: HistoryGroup[];
	truncated: boolean;
}
export interface CodeSearchResult {
	matches: { path: string; line: number; side: "before" | "after"; text: string; kind: string }[];
	truncated: boolean;
	skipped: number;
}
export interface EditorFile {
	path: string;
	content: string;
	warning?: string;
}
export type DesktopResult =
	| DesktopState
	| SnapshotView
	| DirectoryView
	| AccountCatalog
	| AccountCatalogs
	| AccountUsage
	| ProjectHistory
	| CodeSearchResult
	| EditorFile;

export interface SnapshotView {
	files: string[];
	changed: string[];
	path?: string;
	before?: string;
	after?: string;
	diff?: string;
	/** Origin snapshot for each line of the after version. */
	origins?: string[];
	fileOrders?: Record<string, number[]>;
}
