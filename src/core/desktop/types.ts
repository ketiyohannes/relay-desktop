import type { DesktopAccount } from "../accounts/types.ts";

export interface DesktopAction {
	id: string;
	time: number;
	kind: "user" | "assistant" | "tool" | "switch" | "error" | "checkpoint" | "review";
	text: string;
	/** Display-only context label; original text remains in the shared history. */
	label?: string;
	/** Visible chat text. Empty means internal context; raw text stays in the ledger. */
	displayText?: string;
	/** Native message channel, used to exclude reasoning from the chat view. */
	channel?: string;
	/** Provider that produced this action, retained when switching accounts. */
	provider?: string;
	toolId?: string;
	status?: "running" | "done" | "error" | "unknown";
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
	permissionMode?: "ask" | "auto-approve" | "full-access" | "read-only";
	/** Capture and import checkpoints only for this conversation. */
	timelineEnabled?: boolean;
	timelineImportTruncated?: boolean;
	lastEngine?: string;
	claudeSessionId?: string;
	/** Last application-ledger event represented by this desktop projection. */
	relayLedgerSequence?: number;
	importedFrom?: { provider: "codex" | "claude"; sessionId: string; path: string; importedAt: number };
	/** Metadata-only local session; opening materializes it in the shared store. */
	externalSource?: string;
	actions: DesktopAction[];
	/** Desktop IPC carries history only for the opened conversation. */
	actionsLoaded?: boolean;
}

export interface DesktopState {
	projects: string[];
	/** Legacy project opt-ins, converted to session settings when loading saved state. */
	timelineProjects?: string[];
	/** Current capability checks; unavailable repositories never block the conversation. */
	timelineAvailability?: Record<string, boolean>;
	sessions: DesktopSession[];
	accounts: DesktopAccount[];
	busySession?: string;
	/** The in-memory projection is retained and can be saved again. */
	persistenceError?: string;
	sessionDiscovery?: { refreshing: boolean; warnings: string[] };
}

export interface DesktopUpdate {
	session: DesktopSession;
	busySession?: string;
}
