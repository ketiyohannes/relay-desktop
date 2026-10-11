import { sessionChatText, sessionMessageLabel } from "../imports/presentation.ts";
import type { ExternalSession } from "../imports/types.ts";

import { isChangePath } from "../timeline/change-filter.ts";

import type { DesktopAction, DesktopSession, DesktopState } from "./types.ts";
export interface DesktopStateView {
	state: DesktopState;
	incremental: boolean;
	externalSessions: ExternalSession[];
	internalSessions: ReadonlySet<string>;
	importedChannels: ReadonlyMap<string, string>;
	discovery?: Promise<void>;
	discoveryWarnings: string[];
	timelineAvailability: ReadonlyMap<string, boolean>;
	hiddenChanges: ReadonlyMap<string, Set<string>>;
	selectedSessionId?: string;
	localSessionId(source: ExternalSession): string;
}

export function desktopState(view: DesktopStateView, actionFilter?: Set<DesktopAction>): DesktopState {
	const sourceNames = new Map(
		view.externalSessions.map((source) => [`${source.provider}:${source.sessionId}`, source.name]),
	);
	const imported = new Set(
		view.state.sessions.map((session) =>
			session.importedFrom ? `${session.importedFrom.provider}:${session.importedFrom.sessionId}` : "",
		),
	);
	const external = view.externalSessions
		.filter((source) => !imported.has(`${source.provider}:${source.sessionId}`))
		.map(
			(source): DesktopSession => ({
				id: view.localSessionId(source),
				project: source.project,
				name: source.name,
				updated: source.updated,
				accountId: "",
				autoSwitch: true,
				actions: [],
				externalSource: source.id,
				importedFrom: {
					provider: source.provider,
					sessionId: source.sessionId,
					path: source.path,
					importedAt: 0,
				},
			}),
		);
	return {
		...view.state,
		timelineAvailability: Object.fromEntries(view.timelineAvailability),
		projects: [...new Set([...view.state.projects, ...external.map((session) => session.project)])],
		sessionDiscovery: { refreshing: !!view.discovery, warnings: view.discoveryWarnings },
		sessions: [
			...external,
			...view.state.sessions
				.filter((session) => !view.internalSessions.has(session.id))
				.map((session) => {
					const imported = session.importedFrom;
					let name = imported
						? sourceNames.get(`${imported.provider}:${imported.sessionId}`) || session.name
						: session.name;
					if (imported && sessionMessageLabel(name))
						name =
							session.actions.find((action) => action.kind === "user" && !sessionMessageLabel(action.text))?.text ||
							`${imported.provider === "codex" ? "Codex" : "Claude"} session · ${imported.sessionId.slice(0, 8)}`;
					return {
						...session,
						name: name.replace(/\s+/g, " ").trim().slice(0, 120),
						...(view.incremental ? { actionsLoaded: session.id === view.selectedSessionId } : {}),
						actions: session.actions
							.filter((action) =>
								actionFilter ? actionFilter.has(action) : !view.incremental || session.id === view.selectedSessionId,
							)
							.map((action) => ({
								...action,
								label: action.label || (imported ? sessionMessageLabel(action.text) : undefined),
								channel: action.channel || view.importedChannels.get(action.id),
								displayText:
									action.kind === "error" && action.text.startsWith("Timeline unavailable:")
										? ""
										: ["user", "assistant", "review"].includes(action.kind)
											? sessionChatText(
													action.displayText ?? action.text,
													action.channel || view.importedChannels.get(action.id),
												)
											: action.displayText,
								provider:
									action.provider ||
									(imported && action.time <= imported.importedAt
										? imported.provider === "codex"
											? "Codex"
											: "Claude"
										: undefined),
								files: action.files?.filter(
									(path) => isChangePath(path) && !view.hiddenChanges.get(session.project)?.has(path),
								),
							})),
					};
				}),
		],
	};
}
