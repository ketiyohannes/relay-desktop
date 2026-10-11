import type { DesktopBridge, DesktopCommandResult as CommandResult } from "../core/desktop/bridge.ts";
import type {
	DesktopAccount as Account,
	DesktopState as State,
	DesktopCommand as Command,
	DesktopSession as Session,
	DesktopAction as Action,
	DesktopLogin as Login,
} from "../core/desktop/types.ts";
import type * as DiffLibrary from "diff";
import type * as MarkdownLibrary from "marked";
declare global {
	type DesktopAccount = Account;
	type DesktopState = State;
	type DesktopCommand = Command;
	type DesktopCommandResult<C extends Command> = CommandResult<C>;
	type DesktopSession = Session;
	type DesktopAction = Action;
	type DesktopLogin = Login;
	interface Window {
		relay?: DesktopBridge;
		marked: typeof MarkdownLibrary.marked;
	}
	var Diff: typeof DiffLibrary;
	var hljs: {
		getLanguage(language: string): unknown;
		highlight(text: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
	};
	type WorkspaceSelection = { sessionId: string; actionId?: string; path?: string };
	interface WorkspaceToolsApi {
		command<C extends Command>(command: C, options?: { silent?: boolean }): Promise<CommandResult<C>>;
		active(): Session | undefined;
		state(): State;
		busy(): boolean;
		snapshotSelection(): WorkspaceSelection | undefined;
		openSnapshot(action?: Action, path?: string, match?: { query: string; line: number; side: string }): Promise<void>;
		renderTimeline(): void;
		saved(): void;
		openSearchMatch(
			selection: WorkspaceSelection,
			match: { path: string; line: number; side: string; text: string; kind: string },
			query: string,
			scope?: string,
		): Promise<void>;
	}
}
