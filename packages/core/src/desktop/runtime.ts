import { createHash, randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ModelRuntime } from "pi-sdk";
import { ReadOnlyAuthStorage } from "../accounts/readonly-credentials.ts";
import { mergeDuplicateAccounts } from "./account-identity.ts";
import { type AccountCatalogLoader, loadAccountCatalog } from "./accounts.ts";
import { ApprovalPresenter } from "./approvals.ts";
import { isChangePath } from "./change-filter.ts";
import { expandTildePath, getAgentDir } from "./config.ts";
import {
	AccountExhaustedError,
	DesktopEngineBridge,
	type EngineCallbacks,
	projectEvents,
	UncertainExecutionError,
} from "./engines.ts";
import { projectHistory, sessionHistory } from "./history.ts";
import { DesktopLoginManager } from "./login.ts";
import { searchCode } from "./search.ts";
import { DesktopSessionImporter, sessionChatText, sessionMessageLabel } from "./session-import.ts";
import { DesktopStore } from "./store.ts";
import { DesktopTimeline } from "./timeline.ts";
import type {
	DesktopAccount,
	DesktopAction,
	DesktopCommand,
	DesktopLogin,
	DesktopResult,
	DesktopSession,
	DesktopState,
	ExternalSession,
} from "./types.ts";
import { AccountUsageService } from "./usage.ts";
import { browseDirectory, editorFile, saveEditorFile, workspaceView } from "./workspace.ts";

export interface RuntimeHost {
	login?(state: DesktopLogin): void;
	state(state: DesktopState): void;
	permission(
		tool: string,
		input: unknown,
		scope?: { sessionId: string; turnId: string },
		signal?: AbortSignal,
	): Promise<boolean>;
}

export type DesktopEngine = (
	session: DesktopSession,
	account: DesktopAccount,
	prompt: string,
	abort: AbortController,
	callbacks: EngineCallbacks,
) => Promise<void>;

export class DesktopRuntime {
	readonly store: DesktopStore;
	readonly login: DesktopLoginManager;
	private readonly host: RuntimeHost;
	private abort?: AbortController;
	private switching = false;
	private cancelled = false;
	private saving = false;
	private readonly engine: DesktopEngine;
	private readonly bridge?: DesktopEngineBridge;
	private readonly catalog: AccountCatalogLoader;
	private readonly hiddenChanges = new Map<string, Set<string>>();
	private readonly timelineAvailability = new Map<string, boolean>();
	private readonly usage = new AccountUsageService();
	private readonly importer = new DesktopSessionImporter();
	private readonly internalSessions = new Set<string>();
	private readonly importedChannels = new Map<string, string>();
	private externalSessions: ExternalSession[] = [];
	private discovery?: Promise<void>;
	private discoveryWarnings: string[] = [];
	private importQueue: Promise<unknown> = Promise.resolve();
	private readonly discoveryRoots?: { provider: "codex" | "claude"; path?: string }[];
	private globalEvents: Promise<void> = Promise.resolve();
	private accountQueue: Promise<void> = Promise.resolve();
	private initialized = false;
	private readonly externalActive = new Set<string>();
	private readonly approvals: ApprovalPresenter;
	constructor(
		directory: string,
		host: RuntimeHost,
		engine?: DesktopEngine,
		catalog: AccountCatalogLoader = loadAccountCatalog,
		discoveryRoots?: { provider: "codex" | "claude"; path?: string }[],
		bridge = new DesktopEngineBridge(directory),
	) {
		this.discoveryRoots = discoveryRoots;
		this.catalog = catalog;
		this.store = new DesktopStore(directory);
		this.host = host;
		this.login = new DesktopLoginManager(
			directory,
			(state) => this.host.login?.(state),
			(account) => this.saveAccount(account),
		);
		if (!engine) this.bridge = bridge;
		this.approvals = new ApprovalPresenter(
			(approval, sessionId, signal) =>
				this.host.permission(approval.tool, approval.input, { sessionId, turnId: approval.turnId }, signal),
			(sessionId, approvalId, allowed) => bridge.respond(sessionId, approvalId, allowed),
		);
		this.engine =
			engine ??
			((session, account, prompt, abort, callbacks) => bridge.run(session, account, prompt, abort, callbacks));
	}
	async initialize(): Promise<void> {
		await this.store.load();
		const previousAccounts = JSON.stringify(this.store.state.accounts);
		await Promise.all(
			this.store.state.sessions
				.filter((session) => session.importedFrom?.provider === "codex")
				.map(async (session) => {
					try {
						const presentation = await this.importer.presentation(session);
						if (presentation.internal) this.internalSessions.add(session.id);
						for (const [id, channel] of presentation.channels) {
							this.importedChannels.set(id, channel);
							const action = session.actions.find((action) => action.id === id);
							if (action) action.channel = channel;
						}
					} catch {
						/* Saved conversations remain readable when their native source is unavailable. */
					}
				}),
		);
		await Promise.all(
			[...new Set(this.store.state.sessions.map((session) => session.project))].map((project) =>
				this.refreshChangeFilter(project),
			),
		);
		await this.bridge?.observe((event) => {
			this.globalEvents = this.globalEvents
				.then(async () => {
					if (event.sessionId === this.store.state.busySession && this.abort) return;
					if (event.data.type === "created" || event.data.type === "selection" || event.data.type === "workspace")
						await this.synchronizeGlobal();
					const session = this.store.state.sessions.find((session) => session.id === event.sessionId);
					if (!session) return;
					if (event.data.type === "turn" && !event.data.taskId) {
						if (event.data.status === "running") this.externalActive.add(session.id);
						else this.externalActive.delete(session.id);
					}
					if (event.data.type === "approval") this.approvals.update(session.id, event.data.approval);
					if (event.sequence <= (session.relayLedgerSequence ?? 0)) {
						await this.publish();
						return;
					}
					projectEvents(session, [event]);
					session.relayLedgerSequence = event.sequence;
					await this.publish();
				})
				.catch((error: unknown) => {
					process.stderr.write(`Relay projection failure: ${String(error)}\n`);
				});
		});
		await this.synchronizeGlobal();
		await Promise.allSettled(
			this.store.state.accounts
				.filter(
					(account) =>
						!account.identityKey && (account.engine === "claude" || account.provider === "openai-codex"),
				)
				.map(async (account) => {
					const catalog = await this.catalog(account);
					if (catalog.connected) account.identityKey = catalog.identityKey;
				}),
		);
		mergeDuplicateAccounts(this.store.state);
		if (JSON.stringify(this.store.state.accounts) !== previousAccounts) await this.store.save();
		await this.bridge?.recordNotes(this.store.state);
		if (this.bridge) await this.store.save();
		this.initialized = true;
		this.host.state(this.publicState());
	}
	private async synchronizeGlobal(): Promise<void> {
		await this.bridge?.synchronize(this.store.state, (session, global) => {
			if (global.turns.some((turn) => !turn.taskId && turn.status === "running"))
				this.externalActive.add(session.id);
			else this.externalActive.delete(session.id);
			for (const approval of global.approvals) this.approvals.update(session.id, approval);
		});
		mergeDuplicateAccounts(this.store.state);
		if (!this.abort) this.store.state.busySession = [...this.externalActive][0];
	}
	/** Refresh metadata only; source conversations are read when opened. */
	refreshSessions(): Promise<void> {
		if (this.discovery) return this.discovery;
		this.discovery = this.discoverSessions().finally(() => {
			this.discovery = undefined;
			this.host.state(this.publicState());
		});
		this.host.state(this.publicState());
		return this.discovery;
	}
	private async discoverSessions(): Promise<void> {
		await this.synchronizeGlobal();
		if (this.bridge) await this.store.save();
		const roots = this.discoveryRoots ?? [
			{ provider: "codex" as const },
			{ provider: "claude" as const },
			...this.store.state.accounts.flatMap((account) =>
				account.configDir && (account.engine === "claude" || account.credentialSource === "codex")
					? [
							{
								provider: account.engine === "claude" ? ("claude" as const) : ("codex" as const),
								path: account.configDir,
							},
							...(account.equivalentProfiles || []).map((path) => ({
								provider: account.engine === "claude" ? ("claude" as const) : ("codex" as const),
								path,
							})),
						]
					: [],
			),
		];
		const unique = [...new Map(roots.map((root) => [`${root.provider}:${root.path || ""}`, root])).values()];
		const results = await Promise.allSettled(unique.map((root) => this.importer.list(root.provider, root.path)));
		const sources = new Map<string, ExternalSession>();
		const warnings: string[] = [];
		for (const [index, result] of results.entries()) {
			if (result.status === "fulfilled") {
				warnings.push(...result.value.warnings);
				for (const source of result.value.items) {
					const key = `${source.provider}:${source.sessionId}`;
					if (!sources.has(key) || sources.get(key)!.updated < source.updated) sources.set(key, source);
				}
			} else if ((result.reason as NodeJS.ErrnoException)?.code !== "ENOENT") {
				warnings.push(
					`Could not discover ${unique[index].provider} sessions in ${unique[index].path || "the default profile"}.`,
				);
			}
		}
		this.externalSessions = [...sources.values()].sort((a, b) => b.updated - a.updated);
		this.discoveryWarnings = warnings;
	}
	private localSessionId(source: ExternalSession): string {
		return `external-${createHash("sha256").update(`${source.provider}:${source.sessionId}`).digest("hex")}`;
	}
	private queuedImport(sourceId: string, project?: string, automatic = false): Promise<DesktopResult> {
		const operation = this.importQueue.then(() => this.importSession(sourceId, project, automatic));
		this.importQueue = operation.catch(() => {});
		return operation;
	}
	private async refreshChangeFilter(project: string): Promise<void> {
		const paths = [
			...new Set(
				this.store.state.sessions
					.filter((session) => session.project === project)
					.flatMap((session) => session.actions.flatMap((action) => action.files || [])),
			),
		];
		try {
			const visible = new Set(await new DesktopTimeline(project, "filter").visibleChanges(paths));
			this.hiddenChanges.set(project, new Set(paths.filter((path) => !visible.has(path))));
		} catch {
			// A moved or unavailable project must not prevent other sessions from opening.
			this.hiddenChanges.set(project, new Set(paths.filter((path) => !isChangePath(path))));
		}
	}
	private publicState(): DesktopState {
		const sourceNames = new Map(
			this.externalSessions.map((source) => [`${source.provider}:${source.sessionId}`, source.name]),
		);
		const imported = new Set(
			this.store.state.sessions.map((session) =>
				session.importedFrom ? `${session.importedFrom.provider}:${session.importedFrom.sessionId}` : "",
			),
		);
		const external = this.externalSessions
			.filter((source) => !imported.has(`${source.provider}:${source.sessionId}`))
			.map(
				(source): DesktopSession => ({
					id: this.localSessionId(source),
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
			...this.store.state,
			timelineAvailability: Object.fromEntries(this.timelineAvailability),
			projects: [...new Set([...this.store.state.projects, ...external.map((session) => session.project)])],
			sessionDiscovery: { refreshing: !!this.discovery, warnings: this.discoveryWarnings },
			sessions: [
				...external,
				...this.store.state.sessions
					.filter((session) => !this.internalSessions.has(session.id))
					.map((session) => {
						const imported = session.importedFrom;
						let name = imported
							? sourceNames.get(`${imported.provider}:${imported.sessionId}`) || session.name
							: session.name;
						if (imported && sessionMessageLabel(name))
							name =
								session.actions.find((action) => action.kind === "user" && !sessionMessageLabel(action.text))
									?.text ||
								`${imported.provider === "codex" ? "Codex" : "Claude"} session · ${imported.sessionId.slice(0, 8)}`;
						return {
							...session,
							name: name.replace(/\s+/g, " ").trim().slice(0, 120),
							actions: session.actions.map((action) => ({
								...action,
								label: action.label || (imported ? sessionMessageLabel(action.text) : undefined),
								channel: action.channel || this.importedChannels.get(action.id),
								displayText:
									action.kind === "error" && action.text.startsWith("Timeline unavailable:")
										? ""
										: (action.displayText ??
											(["user", "assistant", "review"].includes(action.kind)
												? sessionChatText(
														action.text,
														action.channel || this.importedChannels.get(action.id),
													)
												: undefined)),
								provider:
									action.provider ||
									(imported && action.time <= imported.importedAt
										? imported.provider === "codex"
											? "Codex"
											: "Claude"
										: undefined),
								files: action.files?.filter(
									(path) => isChangePath(path) && !this.hiddenChanges.get(session.project)?.has(path),
								),
							})),
						};
					}),
			],
		};
	}
	private async publish(): Promise<void> {
		if (!this.abort) this.store.state.busySession = [...this.externalActive][0];
		await this.bridge?.recordNotes(this.store.state);
		await this.store.save();
		if (this.initialized) this.host.state(this.publicState());
	}
	private async publishSelection(session: DesktopSession): Promise<void> {
		const account = this.store.state.accounts.find((account) => account.id === session.accountId);
		if (this.store.state.busySession !== session.id) await this.bridge?.select(session, account);
		await this.publish();
	}
	private async snapshotAction(session: DesktopSession, id: string): Promise<DesktopAction | undefined> {
		const local = session.actions.find((action) => action.id === id);
		if (local || !id.startsWith("history:")) return local;
		const history = await projectHistory(new DesktopTimeline(session.project, session.id));
		return history.groups
			.flatMap((group) => [...(group.action ? [group.action] : []), ...group.events])
			.find((action) => action.id === id);
	}
	private async importSession(sourceId: string, overrideProject?: string, automatic = false): Promise<DesktopResult> {
		if ((!automatic && this.abort) || this.saving)
			throw new Error("Wait for the current run or save before importing");
		this.saving = true;
		try {
			const { source, actions, warnings } = await this.importer.preview(sourceId);
			const existing = this.store.state.sessions.find(
				(session) =>
					session.importedFrom?.provider === source.provider &&
					session.importedFrom.sessionId === source.sessionId,
			);
			if (existing) return { importedSessionId: existing.id };
			let project = overrideProject ? await realpath(expandTildePath(overrideProject)) : source.project;
			if (overrideProject && !(await stat(project)).isDirectory()) throw new Error("Choose a project folder");
			if (!automatic && (!project || !isAbsolute(project)))
				throw new Error("Choose a project folder for this session");
			if (automatic && !isAbsolute(project)) project = "";
			try {
				project = await realpath(project);
			} catch {
				warnings.push("Original project is unavailable. Use Link folder before sending a prompt.");
			}
			const account =
				this.store.state.accounts.find((entry) =>
					source.provider === "claude" ? entry.engine === "claude" : entry.provider === "openai-codex",
				) || this.store.state.accounts[0];
			const session: DesktopSession = {
				id: automatic ? this.localSessionId(source) : randomUUID(),
				project,
				name: source.name.slice(0, 120),
				updated: source.updated,
				accountId: account?.id || "",
				autoSwitch: true,
				actions,
				importedFrom: {
					provider: source.provider,
					sessionId: source.sessionId,
					path: source.path,
					importedAt: Date.now(),
				},
			};
			this.store.append(session, {
				kind: "switch",
				label: "Import details",
				text: `Imported from ${source.provider === "claude" ? "Claude" : "Codex"}. ${warnings.join(" ")}`,
			});
			session.updated = source.updated;
			const addedProject = !this.store.state.projects.includes(project);
			if (addedProject) this.store.state.projects.push(project);
			this.store.state.sessions.push(session);
			try {
				await this.publish();
			} catch (error) {
				this.store.state.sessions = this.store.state.sessions.filter((entry) => entry !== session);
				if (addedProject)
					this.store.state.projects = this.store.state.projects.filter((entry) => entry !== project);
				throw error;
			}
			return { importedSessionId: session.id };
		} finally {
			this.saving = false;
		}
	}
	async command(command: DesktopCommand): Promise<DesktopResult> {
		if (command.type === "refresh_sessions") {
			await this.refreshSessions();
			return this.publicState();
		}
		if ("sessionId" in command && !this.store.state.sessions.some((session) => session.id === command.sessionId)) {
			const source = this.externalSessions.find((source) => this.localSessionId(source) === command.sessionId);
			if (!source) throw new Error("Session is no longer available. Refresh the session list.");
			const result = await this.queuedImport(source.id, undefined, true);
			if ("importedSessionId" in result) return this.command({ ...command, sessionId: result.importedSessionId });
		}
		if (command.type === "session_load") return this.publicState();
		if (command.type === "timeline_status" || command.type === "timeline_enable") {
			if (command.type === "timeline_enable" && (this.abort || this.saving))
				throw new Error("Stop the current run before changing timeline settings");
			const session = this.store.session(command.sessionId);
			const timeline = new DesktopTimeline(session.project, session.id);
			const supported = await timeline.supported();
			this.timelineAvailability.set(session.project, supported);
			if (command.type === "timeline_enable") {
				if (this.abort || this.saving) throw new Error("Stop the current run before changing timeline settings");
				this.saving = true;
				try {
					if (command.enabled && supported) {
						const history = await sessionHistory(timeline, session);
						session.timelineImportTruncated = history.truncated;
						for (const action of history.groups.flatMap((group) => group.events)) {
							if (
								session.actions.some(
									(existing) => existing.kind === "checkpoint" && existing.snapshot === action.snapshot,
								)
							)
								continue;
							const index = session.actions.findIndex((existing) => existing.time > action.time);
							session.actions.splice(index < 0 ? session.actions.length : index, 0, action);
						}
					}
					session.timelineEnabled = command.enabled && supported;
					await this.publish();
				} finally {
					this.saving = false;
				}
			}
			return {
				timeline: { supported, enabled: session.timelineEnabled ?? false },
			};
		}
		if (command.type === "session_permissions") {
			if (this.abort || this.saving) throw new Error("Stop the current run before changing permissions");
			if (!["ask", "auto-edit", "read-only"].includes(command.mode)) throw new Error("Unknown permission mode");
			this.store.session(command.sessionId).permissionMode = command.mode;
			await this.publish();
			return this.publicState();
		}
		if (command.type === "external_sessions") {
			const result = await this.importer.list(command.provider, command.path);
			for (const item of result.items)
				item.importedSessionId = this.store.state.sessions.find(
					(session) =>
						session.importedFrom?.provider === item.provider && session.importedFrom.sessionId === item.sessionId,
				)?.id;
			return result;
		}
		if (command.type === "external_preview") return this.importer.preview(command.sourceId);
		if (command.type === "import_session") return this.queuedImport(command.sourceId, command.project);
		if (command.type === "session_project") {
			if (this.abort || this.saving) throw new Error("Stop the current run before linking a folder");
			const project = await realpath(expandTildePath(command.project));
			if (!(await stat(project)).isDirectory()) throw new Error("Choose a project folder");
			if (this.abort || this.saving) throw new Error("Stop the current run before linking a folder");
			const session = this.store.session(command.sessionId);
			session.project = project;
			delete session.claudeSessionId;
			delete session.lastEngine;
			if (!this.store.state.projects.includes(project)) this.store.state.projects.push(project);
			this.store.append(session, {
				kind: "switch",
				text: `Project folder linked: ${project}. Inspect current files before continuing.`,
			});
			await this.publishSelection(session);
			return this.publicState();
		}
		if (command.type === "history") {
			const session = this.store.session(command.sessionId);
			const timeline = new DesktopTimeline(session.project, session.id);
			if (!(await timeline.supported())) {
				this.timelineAvailability.set(session.project, false);
				return { groups: [], truncated: false, message: "Timeline is not supported for this project." };
			}
			if (!session.timelineEnabled)
				return { groups: [], truncated: false, message: "Import timeline to view project history." };
			try {
				return await projectHistory(timeline);
			} catch {
				return { groups: [], truncated: false, message: "Timeline is unavailable for this project." };
			}
		}
		if (command.type === "search_code") {
			const session = this.store.session(command.sessionId);
			const action = command.actionId ? await this.snapshotAction(session, command.actionId) : undefined;
			if (command.actionId && !action?.snapshot) throw new Error("Snapshot is no longer available");
			const timeline = new DesktopTimeline(session.project, session.id);
			const load = (path?: string) =>
				action?.snapshot
					? timeline.view(action.snapshot, action.previous, path, action.rootCommit)
					: workspaceView(session.project, path);
			return searchCode(await load(), load, command.query, command.scope, command.path);
		}
		if (command.type === "editor_read") {
			const session = this.store.session(command.sessionId);
			let path = command.path;
			if (command.actionId) {
				const action = await this.snapshotAction(session, command.actionId);
				if (!action?.snapshot) throw new Error("Unknown snapshot");
				const timeline = new DesktopTimeline(session.project, session.id);
				path = relative(
					session.project,
					resolve((await timeline.git(["rev-parse", "--show-toplevel"])).trim(), path),
				);
			}
			return editorFile(session.project, path);
		}
		if (command.type === "editor_save") {
			if (this.abort || this.saving) throw new Error("Wait for the current run or save to finish before saving.");
			this.saving = true;
			try {
				const session = this.store.session(command.sessionId);
				const timeline = new DesktopTimeline(session.project, session.id);
				let capturing = session.timelineEnabled ?? false;
				if (capturing)
					try {
						const baseline = await timeline.checkpoint("Before manual edit");
						if (baseline.snapshot !== baseline.previous)
							this.store.append(session, { kind: "checkpoint", text: "Before manual edit", ...baseline });
					} catch {
						capturing = false;
						this.timelineAvailability.set(session.project, false);
					}
				const file = this.bridge
					? await this.bridge.saveFile(session, command.path, command.expected, command.content)
					: await saveEditorFile(session.project, command.path, command.expected, command.content);
				if (capturing) {
					try {
						const snapshot = await timeline.checkpoint(`Manual edit · ${command.path}`);
						if (snapshot.snapshot !== snapshot.previous)
							this.store.append(session, {
								kind: "checkpoint",
								text: `Manual edit · ${command.path}`,
								...snapshot,
							});
					} catch {
						file.warning = "Saved, but the timeline snapshot could not be recorded.";
					}
				}
				session.updated = Date.now();
				await this.refreshChangeFilter(session.project);
				await this.publish();
				return file;
			} finally {
				this.saving = false;
			}
		}
		if (command.type === "login_start") {
			if (this.abort) throw new Error("Stop the current run before signing in");
			this.login.start(command.provider, command.name);
			return this.publicState();
		}
		if (command.type === "login_reply") {
			this.login.reply(command.id, command.value);
			return this.publicState();
		}
		if (command.type === "login_cancel") {
			await this.login.cancel();
			return this.publicState();
		}
		if (command.type === "cancel") {
			this.cancelled = true;
			this.switching = false;
			this.abort?.abort();
			if (!this.abort && this.store.state.busySession) await this.bridge?.cancel(this.store.state.busySession);
			return this.publicState();
		}
		if (command.type === "state") return this.publicState();
		if (command.type === "account_usage") {
			const account = this.store.state.accounts.find((entry) => entry.id === command.accountId);
			if (!account) throw new Error("Unknown account");
			return this.usage.read(account, command.refresh);
		}
		if (command.type === "account_catalogs") {
			const accounts = [...this.store.state.accounts];
			const results = await Promise.allSettled(accounts.map((account) => this.catalog(account)));
			for (const [index, result] of results.entries()) {
				if (result.status === "fulfilled" && result.value.connected)
					accounts[index].identityKey = result.value.identityKey;
			}
			if (!this.abort) {
				mergeDuplicateAccounts(this.store.state);
				await this.publish();
			}
			return {
				accounts: results.flatMap((result, index) =>
					this.store.state.accounts.includes(accounts[index])
						? [
								{
									accountId: accounts[index].id,
									...(result.status === "fulfilled"
										? { catalog: result.value }
										: { error: "Connection check failed. Retry or sign in again." }),
								},
							]
						: [],
				),
			};
		}
		if (command.type === "account_catalog" || command.type === "select_model") {
			const account = this.store.state.accounts.find((entry) => entry.id === command.accountId);
			if (!account) throw new Error("Unknown account");
			if (command.type === "select_model" && this.abort)
				throw new Error("Stop the current run before changing models");
			const previousAccount =
				command.type === "select_model" ? this.store.session(command.sessionId).accountId : undefined;
			const catalog = await this.catalog(account);
			if (command.type === "account_catalog") return catalog;
			const session = this.store.session(command.sessionId);
			if (this.abort || session.accountId !== previousAccount || !this.store.state.accounts.includes(account))
				throw new Error("The active account changed. Reopen the model picker.");
			if (
				catalog.connected === false ||
				!catalog.models.some((model) => model.id === command.model && model.authenticated)
			)
				throw new Error("This model is not available for the selected account");
			if (session.accountId !== account.id || (session.models?.[account.id] ?? account.model) !== command.model) {
				session.accountId = account.id;
				session.models = { ...session.models, [account.id]: command.model };
				this.store.append(session, { kind: "switch", text: `Model → ${command.model} (${account.name})` });
				await this.publishSelection(session);
			}
			return this.publicState();
		}
		if (command.type === "browse") return browseDirectory(command.path);
		if (command.type === "workspace") {
			const project = this.store.session(command.sessionId).project;
			if (!command.path) {
				await this.refreshChangeFilter(project);
				this.host.state(this.publicState());
			}
			return workspaceView(project, command.path);
		}
		if (command.type === "catalog") {
			if (command.credentialSource === "codex")
				return this.catalog({
					id: "",
					name: "Codex",
					engine: "pi",
					provider: "openai-codex",
					model: "",
					credentialSource: "codex",
					configDir: command.configDir || "",
				});
			if (command.engine === "claude")
				return this.catalog({
					id: "",
					name: "Claude",
					engine: "claude",
					provider: "",
					model: "",
					configDir: command.configDir || "",
				});
			const configDir = expandTildePath(command.configDir || getAgentDir());
			const credentials = new ReadOnlyAuthStorage(join(configDir, "auth.json"));
			const stored = new Set((await credentials.list()).map((entry) => entry.providerId));
			const runtime = await ModelRuntime.create({
				credentials,
				modelsPath: join(configDir, "models.json"),
				refreshOnCreate: false,
			});
			return {
				configDir,
				models: runtime.getModels().map((model) => ({
					provider: model.provider,
					id: model.id,
					name: model.name,
					authenticated: stored.has(model.provider),
				})),
			};
		}
		if (command.type === "snapshot") {
			const session = this.store.session(command.sessionId);
			const action = await this.snapshotAction(session, command.actionId);
			if (!action?.snapshot) throw new Error("No snapshot for this action");
			const view = await new DesktopTimeline(session.project, session.id).view(
				action.snapshot,
				action.previous,
				command.path,
				action.rootCommit,
			);
			if (!command.path) {
				let events = session.actions.filter((entry) => entry.kind === "checkpoint" && entry.files?.length);
				if (action.id.startsWith("history:")) {
					const timeline = new DesktopTimeline(session.project, session.id);
					const history = await projectHistory(timeline);
					const group = history.groups.find(
						(group) => group.action?.id === action.id || group.events.some((event) => event.id === action.id),
					);
					events = group?.events || [];
					const selected = events.findIndex((event) => event.id === action.id);
					if (selected >= 0) events = events.slice(0, selected + 1);
					// Batch ref metadata stays cheap; detailed annotations are bounded for large histories.
					events = events.slice(-100);
					for (const event of events) event.files = (await timeline.view(event.snapshot!, event.previous)).changed;
				} else {
					const selected = events.findIndex((event) => event.id === action.id);
					if (selected >= 0) events = events.slice(0, selected + 1);
				}
				view.fileOrders = Object.create(null) as Record<string, number[]>;
				events.forEach((event, index) => {
					for (const path of event.files || []) {
						if (!view.changed.includes(path) && !view.files.includes(path)) continue;
						view.fileOrders![path] ??= [];
						view.fileOrders![path].push(event.changeOrder || index + 1);
					}
				});
			}
			return view;
		}
		if (command.type === "review") {
			const session = this.store.session(command.sessionId);
			const action = await this.snapshotAction(session, command.actionId);
			if (!action?.snapshot) throw new Error("Review requires a historical snapshot");
			this.store.append(session, {
				kind: "review",
				text: command.text,
				snapshot: action.snapshot,
				previous: action.previous,
			});
			await this.publish();
			return this.publicState();
		}
		if (command.type === "prompt" || command.type === "review_snapshot") {
			if (this.login.busy) throw new Error("Finish or cancel sign-in before starting a run");
			if (this.abort || this.saving)
				throw new Error("Another run or save is in progress. Wait before starting a new run.");
			const session = this.store.session(command.sessionId);
			let text: string;
			let review: DesktopAction | undefined;
			let reviewDirectory: string | undefined;
			if (command.type === "review_snapshot") {
				review = await this.snapshotAction(session, command.actionId);
				if (!review?.snapshot) throw new Error("Review requires a snapshot");
				const timeline = new DesktopTimeline(session.project, session.id);
				const view = await timeline.view(review.snapshot, review.previous, undefined, review.rootCommit);
				const context: string[] = [];
				let bytes = 0;
				for (const path of view.changed) {
					const file = await timeline.view(review.snapshot, review.previous, path, review.rootCommit);
					const content = JSON.stringify({ path, before: file.before, after: file.after, diff: file.diff });
					bytes += content.length;
					if (bytes > 160000)
						throw new Error("Snapshot is too large for one review. Review a smaller checkpoint.");
					context.push(content);
				}
				text = `Review this immutable code snapshot for concrete bugs and regressions. Cite file:line, explain the failure, and suggest a fix. Read surrounding code in the exported snapshot using read-only tools. Do not edit files. State any context limitations. Snapshot ${review.snapshot}. Full repository file list: ${JSON.stringify(view.files)}. Changed files and complete before/after contents:\n${context.join("\n")}`;
				reviewDirectory = await timeline.exportSnapshot(review.snapshot);
			} else {
				text = command.text;
				if (!text.trim()) throw new Error("Enter a prompt");
				if (!(await stat(session.project).catch(() => undefined))?.isDirectory())
					throw new Error("Project folder is unavailable. Use Link folder to choose its current location.");
			}
			if (!this.store.state.accounts.some((a) => a.id === session.accountId)) {
				if (reviewDirectory) await rm(reviewDirectory, { recursive: true, force: true });
				throw new Error("Add and select an account first");
			}
			if (this.abort || this.saving) {
				if (reviewDirectory) await rm(reviewDirectory, { recursive: true, force: true });
				throw new Error("Another session is running");
			}
			this.abort = new AbortController();
			this.cancelled = false;
			this.store.state.busySession = session.id;
			if (!review) {
				if (!session.actions.some((a) => a.kind === "user")) session.name = text.slice(0, 48);
				this.store.append(session, { kind: "user", text });
			}
			try {
				await this.publish();
			} catch (error) {
				this.abort = undefined;
				delete this.store.state.busySession;
				if (reviewDirectory) await rm(reviewDirectory, { recursive: true, force: true });
				throw error;
			}
			void this.run(session, text, this.abort, review, reviewDirectory).catch((error: unknown) => {
				process.stderr.write(`Relay persistence failure: ${String(error)}\n`);
			});
			return this.publicState();
		}
		if (command.type === "select_account") {
			const session = this.store.session(command.sessionId);
			const next = this.store.state.accounts.find((a) => a.id === command.accountId);
			if (!next) throw new Error("Unknown account");
			if (session.accountId !== next.id) {
				const previous = this.store.state.accounts.find((a) => a.id === session.accountId);
				this.store.append(session, {
					kind: "switch",
					text: `${previous?.name || "No account"} → ${next.name} (manual)`,
				});
				if (this.store.state.busySession === session.id) {
					this.switching = true;
					this.abort?.abort();
				}
			}
			session.accountId = next.id;
			session.autoSwitch = command.autoSwitch;
			await this.publishSelection(session);
			return this.publicState();
		}
		if (this.abort) throw new Error("Stop the current run before changing projects or accounts");
		if (command.type === "move_account") {
			const index = this.store.state.accounts.findIndex((account) => account.id === command.accountId);
			if (index < 0 || ![-1, 1].includes(command.offset)) throw new Error("Invalid account order");
			const target = index + command.offset;
			if (target >= 0 && target < this.store.state.accounts.length) {
				const [account] = this.store.state.accounts.splice(index, 1);
				this.store.state.accounts.splice(target, 0, account);
			}
		}
		if (command.type === "project") {
			const path = await realpath(command.path);
			if (!(await stat(path)).isDirectory()) throw new Error("Choose a folder");
			if (!this.store.state.projects.includes(path)) this.store.state.projects.push(path);
		}
		if (command.type === "session") {
			const project = await realpath(command.project);
			if (!this.store.state.projects.includes(project)) throw new Error("Open the project first");
			this.store.state.sessions.push({
				id: randomUUID(),
				project,
				name: "Untitled session",
				updated: Date.now(),
				accountId: this.store.state.accounts[0]?.id ?? "",
				autoSwitch: true,
				actions: [],
			});
			await this.publishSelection(this.store.state.sessions.at(-1)!);
		}
		if (command.type === "account") {
			await this.saveAccount(command.account);
			return this.publicState();
		}
		await this.publish();
		return this.publicState();
	}

	private saveAccount(input: DesktopAccount): Promise<void> {
		const operation = this.accountQueue.then(async () => {
			const account = { ...input, configDir: expandTildePath(input.configDir) };
			if (!["claude", "pi"].includes(account.engine) || !account.name.trim()) throw new Error("Invalid account");
			if (account.configDir && !(await stat(account.configDir)).isDirectory())
				throw new Error("Account config directory does not exist");
			if (account.engine === "pi" && (!account.provider || !account.model))
				throw new Error("Pi needs a provider and model ID");
			if (account.credentialSource === "codex" && (account.engine !== "pi" || account.provider !== "openai-codex"))
				throw new Error("Codex credentials require Pi's openai-codex provider");
			const catalog = await this.catalog(account);
			if (!catalog.connected)
				throw new Error("No authentication found. Sign in or choose an authenticated profile.");
			if (
				!catalog.models.some(
					(model) =>
						model.id === account.model ||
						(account.engine === "claude" && model.id === "default" && !account.model),
				)
			)
				throw new Error("Choose a model from this account's model list");
			account.configDir = catalog.configDir;
			account.identityKey = catalog.identityKey;
			if (this.abort) throw new Error("Stop the current run before changing accounts");
			const before = structuredClone(this.store.state);
			const index = this.store.state.accounts.findIndex(
				(entry) =>
					entry.id === account.id ||
					(entry.engine === account.engine &&
						entry.provider === account.provider &&
						((!!account.identityKey && entry.identityKey === account.identityKey) ||
							(!!account.configDir &&
								(entry.configDir === account.configDir ||
									entry.equivalentProfiles?.includes(account.configDir))))),
			);
			if (index < 0) this.store.state.accounts.push({ ...account, id: randomUUID() });
			else {
				const existing = this.store.state.accounts[index];
				this.store.state.accounts[index] = {
					...account,
					id: existing.id,
					name: input.id === existing.id ? account.name : existing.name,
					equivalentProfiles: [...new Set([...(existing.equivalentProfiles || []), existing.configDir])].filter(
						(profile) => profile && profile !== account.configDir,
					),
				};
			}
			mergeDuplicateAccounts(this.store.state);
			try {
				await this.publish();
			} catch (error) {
				this.store.state = before;
				throw error;
			}
		});
		this.accountQueue = operation.catch(() => {});
		return operation;
	}

	private async run(
		session: DesktopSession,
		text: string,
		abort: AbortController,
		review?: DesktopAction,
		reviewDirectory?: string,
	): Promise<void> {
		const timeline = new DesktopTimeline(session.project, session.id);
		let assistant: DesktopAction | undefined;
		let uncertain = false;
		let timelineEnabled = session.timelineEnabled ?? false;
		let respondingProvider: string | undefined;
		let watcher: FSWatcher | undefined;
		let observation: ReturnType<typeof setTimeout> | undefined;
		let observationWork: Promise<void> = Promise.resolve();
		const callbacks: EngineCallbacks = {
			...(review ? { review: { parentSessionId: session.id } } : {}),
			...(this.bridge && !review
				? ({
						event: async (event) => {
							projectEvents(session, [event]);
							session.relayLedgerSequence = event.sequence;
							await this.publish();
						},
					} satisfies Pick<EngineCallbacks, "event">)
				: {}),
			readOnly: !!review || session.permissionMode === "read-only",
			permission: async (tool, input, scope, signal) => {
				const readOnlyRoot =
					reviewDirectory || (session.permissionMode === "read-only" ? session.project : undefined);
				if (!readOnlyRoot) {
					if (
						session.permissionMode === "auto-edit" &&
						[
							"read",
							"grep",
							"find",
							"ls",
							"write",
							"edit",
							"Read",
							"Grep",
							"Glob",
							"Write",
							"Edit",
							"NotebookEdit",
						].includes(tool)
					)
						return true;
					return this.host.permission(tool, input, scope, signal);
				}
				if (!["read", "grep", "find", "ls", "Read", "Grep", "Glob"].includes(tool)) return false;
				const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
				const path =
					typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : ".";
				try {
					const local = relative(await realpath(readOnlyRoot), await realpath(resolve(readOnlyRoot, path)));
					return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
				} catch {
					return false;
				}
			},
			session: async (id) => {
				if (review) return;
				session.claudeSessionId = id;
				await this.store.save();
			},
			text: async (id, content, complete) => {
				if (this.bridge && !review) assistant = session.actions.find((action) => action.id === id);
				if (!content && !assistant) return;
				if (!assistant)
					assistant = this.store.append(session, {
						kind: review ? "review" : "assistant",
						provider: respondingProvider,
						text: "",
						status: "running",
						...(review ? { snapshot: review.snapshot, previous: review.previous } : {}),
					});
				if (this.bridge && !review) assistant.id = id;
				assistant.text = complete ? content : assistant.text + content;
				if (complete) {
					assistant.status = "done";
					assistant = undefined;
				}
				await this.publish();
			},
			tool: async (id, name, input, result, failed) => {
				let action = session.actions.find((a) => a.kind === "tool" && a.toolId === id);
				if (!action)
					action = this.store.append(session, {
						kind: "tool",
						provider: respondingProvider,
						text: name,
						toolId: id,
						input: JSON.stringify(input, null, 2),
						status: "running",
					});
				if (this.bridge && !review) action.id = id;
				if (result !== undefined) {
					action.output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
					action.text = `${name}\n${JSON.stringify(result, null, 2)}`;
					action.status = failed ? "error" : "done";
					action.finished = Date.now();
					delete action.progress;
				}
				await this.publish();
			},
			toolProgress: async (id, progress, output) => {
				const action = session.actions.find(
					(entry) => entry.kind === "tool" && entry.toolId === id && entry.status === "running",
				);
				if (!action) return;
				action.progress = progress;
				if (output !== undefined)
					action.output = typeof output === "string" ? output : JSON.stringify(output, null, 2);
				await this.publish();
			},
			checkpoint: async (label, toolId) => {
				if (!timelineEnabled || review) return;
				try {
					const snapshot = await timeline.checkpoint(label);
					if (snapshot.snapshot !== snapshot.previous) {
						this.store.append(session, { kind: "checkpoint", text: label, toolId, ...snapshot });
						await this.refreshChangeFilter(session.project);
						await this.publish();
					}
				} catch {
					timelineEnabled = false;
					this.timelineAvailability.set(session.project, false);
					await this.publish();
				}
			},
		};
		try {
			await callbacks.checkpoint("Session baseline");
			if (timelineEnabled && !review) {
				try {
					watcher = watch(session.project, { recursive: true }, (_event, file) => {
						if (!file || !isChangePath(file.toString())) return;
						if (observation) clearTimeout(observation);
						observation = setTimeout(() => {
							observation = undefined;
							observationWork = observationWork.then(() => callbacks.checkpoint("Live filesystem observation"));
							void observationWork.catch(() => {});
						}, 120);
					});
					watcher.on("error", () => watcher?.close());
				} catch {
					/* Tool-boundary capture remains available when recursive watching is unsupported. */
				}
			}
			const attempted = new Set<string>();
			let prompt = text;
			while (!this.cancelled && (!abort.signal.aborted || this.switching)) {
				if (this.switching && abort.signal.aborted) {
					this.switching = false;
					abort = new AbortController();
					this.abort = abort;
				}
				const account = this.store.state.accounts.find((a) => a.id === session.accountId);
				if (!account) throw new Error("Account unavailable");
				attempted.add(account.id);
				respondingProvider =
					account.engine === "claude"
						? "Claude"
						: account.provider === "openai-codex"
							? "Codex"
							: account.provider;
				try {
					await this.engine(
						reviewDirectory ? { ...session, project: reviewDirectory, claudeSessionId: undefined } : session,
						{ ...account, model: session.models?.[account.id] ?? account.model },
						prompt,
						abort,
						callbacks,
					);
					if (this.switching) throw new Error("Account switch requested");
					if (!review) session.lastEngine = account.engine;
					break;
				} catch (error) {
					if (!review) session.lastEngine = account.engine;
					if (error instanceof UncertainExecutionError) {
						this.switching = false;
						throw error;
					}
					if (this.switching) {
						this.switching = false;
						if (assistant) {
							assistant.status = "error";
							assistant = undefined;
						}
						for (const action of session.actions) {
							if (action.kind === "tool" && action.status === "running") {
								action.status = "error";
								action.text += "\nInterrupted by account switch. Inspect working files before continuing.";
							}
						}
						await callbacks.checkpoint("Manual switch settled");
						if (this.cancelled) break;
						abort = new AbortController();
						this.abort = abort;
						prompt = review
							? text
							: "Continue the interrupted request from Relay history. Inspect current files and completed tool results first. Do not replay completed commands or edits.";
						await this.publish();
						continue;
					}
					if (!(error instanceof AccountExhaustedError) || !session.autoSwitch || abort.signal.aborted)
						throw error;
					const index = this.store.state.accounts.findIndex((a) => a.id === account.id);
					const candidates = [
						...this.store.state.accounts.slice(index + 1),
						...this.store.state.accounts.slice(0, index),
					].filter((a) => !attempted.has(a.id));
					let next: DesktopAccount | undefined;
					for (const candidate of candidates) {
						attempted.add(candidate.id);
						try {
							const catalog = await this.catalog(candidate);
							const model = session.models?.[candidate.id] ?? candidate.model;
							if (
								catalog.connected === false ||
								!catalog.models.some(
									(entry) =>
										entry.authenticated &&
										(entry.id === model ||
											(candidate.engine === "claude" && !model && entry.id === "default")),
								)
							)
								throw new Error("Selected model or authentication unavailable");
							next = candidate;
						} catch {
							this.store.append(session, {
								kind: "switch",
								text: `Skipped ${candidate.name}: connection or selected model unavailable`,
							});
						}
						if (next || this.cancelled || this.switching || abort.signal.aborted) break;
					}
					if (this.cancelled) break;
					if (this.switching) continue;
					if (!session.autoSwitch) throw error;
					if (!next) throw new Error("All configured accounts are exhausted or unavailable");
					if (assistant) {
						assistant.status = "error";
						assistant = undefined;
					}
					for (const action of session.actions) {
						if (action.kind === "tool" && action.status === "running") {
							action.status = "error";
							action.text += "\nInterrupted by quota exhaustion. Inspect working files before continuing.";
						}
					}
					await callbacks.checkpoint("Quota switch settled");
					if (this.cancelled) break;
					if (this.switching) continue;
					if (!session.autoSwitch) throw error;
					this.store.append(session, { kind: "switch", text: `${account.name} exhausted → ${next.name}` });
					session.accountId = next.id;
					prompt = review
						? text
						: "Continue the interrupted request from the Relay history. Inspect current files and completed tool results first. Do not replay completed commands or edits.";
					await this.publish();
				}
			}
		} catch (error) {
			uncertain = error instanceof UncertainExecutionError;
			this.store.append(session, { kind: "error", text: error instanceof Error ? error.message : String(error) });
			if (uncertain && reviewDirectory)
				this.store.append(session, {
					kind: "error",
					text: `Review workspace retained for reconciliation: ${reviewDirectory}`,
				});
		} finally {
			watcher?.close();
			if (observation) clearTimeout(observation);
			await observationWork.catch(() => {});
			if (assistant) assistant.status = "error";
			for (const action of session.actions) {
				if (action.kind === "tool" && action.status === "running") {
					action.status = "error";
					action.text += "\nInterrupted; the tool outcome is unknown. Inspect working files before continuing.";
				}
			}
			await callbacks.checkpoint("Run settled");
			if (reviewDirectory && !uncertain) await rm(reviewDirectory, { recursive: true, force: true });
			delete this.store.state.busySession;
			this.abort = undefined;
			this.switching = false;
			await this.publish();
		}
	}
}
