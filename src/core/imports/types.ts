import type { DesktopAction } from "../desktop/types.ts";

export interface ExternalSession {
	id: string;
	provider: "codex" | "claude";
	sessionId: string;
	name: string;
	project: string;
	path: string;
	updated: number;
	importedSessionId?: string;
}

export interface ExternalSessions {
	items: ExternalSession[];
	path: string;
	warnings: string[];
}

export interface ExternalSessionPreview {
	source: ExternalSession;
	actions: DesktopAction[];
	warnings: string[];
}
