import type { RecoveryEntry } from "../contracts.ts";
import type {
	AccountCatalog,
	AccountCatalogs,
	AccountUsage,
	CodeSearchResult,
	DesktopCommand,
	DesktopLogin,
	DesktopState,
	DesktopUpdate,
	DirectoryView,
	EditorFile,
	ExternalSessionPreview,
	ExternalSessions,
	ProjectHistory,
	SnapshotView,
} from "./types.ts";

export type DesktopCommandResult<C extends DesktopCommand> = C["type"] extends "browse"
	? DirectoryView
	: C["type"] extends "workspace" | "snapshot"
		? SnapshotView
		: C["type"] extends "editor_read" | "editor_save"
			? EditorFile
			: C["type"] extends "history"
				? ProjectHistory
				: C["type"] extends "search_code"
					? CodeSearchResult
					: C["type"] extends "account_catalog" | "catalog"
						? AccountCatalog
						: C["type"] extends "account_catalogs"
							? AccountCatalogs
							: C["type"] extends "account_usage"
								? AccountUsage
								: C["type"] extends "external_sessions"
									? ExternalSessions
									: C["type"] extends "external_preview"
										? ExternalSessionPreview
										: C["type"] extends "import_session"
											? { importedSessionId: string }
											: C["type"] extends "timeline_status" | "timeline_enable"
												? { timeline: { supported: boolean; enabled: boolean } }
												: C["type"] extends "recovery"
													? { recovery: RecoveryEntry[] }
													: DesktopState;

export interface DesktopBridge {
	command<C extends DesktopCommand>(command: C): Promise<DesktopCommandResult<C>>;
	reveal(path: string): Promise<void>;
	permission(id: string, allowed: boolean, allowRun?: boolean): Promise<void>;
	openUrl(url: string): Promise<void>;
	onLogin(callback: (state: DesktopLogin) => void): void;
	onPermission(callback: (request: { id: string; tool: string; input: unknown }) => void): void;
	onPermissionClosed(callback: (id: string) => void): void;
	onState(callback: (state: DesktopState) => void): void;
	onUpdate(callback: (update: DesktopUpdate) => void): void;
	onError(callback: (message: string) => void): void;
}
