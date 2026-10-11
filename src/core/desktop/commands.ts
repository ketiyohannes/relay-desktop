import { rm, stat } from "node:fs/promises";
import { AccountManager } from "../accounts/accounts.ts";
import { type AccountCatalogLoader, loadAccountCatalog } from "../accounts/catalog.ts";
import { accountCommands } from "../accounts/commands.ts";
import { mergeDuplicateAccounts } from "../accounts/identity.ts";
import { DesktopLoginManager } from "../accounts/login.ts";
import type { DesktopLogin } from "../accounts/types.ts";
import { AccountUsageService } from "../accounts/usage.ts";
import { SessionImports } from "../imports/import-session.ts";
import { ApprovalPresenter } from "../permissions/presenter.ts";
import { prepareReview } from "../reviews/context.ts";
import { sessionCommands } from "../sessions/commands.ts";
import { ConversationRunner, type DesktopEngine } from "../sessions/conversation-runner.ts";
import { projectEvents } from "../sessions/desktop-projection.ts";
import { snapshotAction } from "../timeline/actions.ts";
import { isChangePath } from "../timeline/change-filter.ts";
import { timelineCommands } from "../timeline/commands.ts";
import { DesktopTimeline } from "../timeline/snapshots.ts";
import { workspaceCommands } from "../workspace/commands.ts";
import type { DesktopCommand, DesktopResult } from "./protocol.ts";
import { DesktopEngineBridge } from "./service-connection.ts";
import { desktopState } from "./state.ts";
import { DesktopStore } from "./store.ts";
import type { DesktopAction, DesktopSession, DesktopState, DesktopUpdate } from "./types.ts";
import { DesktopUpdates } from "./updates.ts";

export interface RuntimeHost {
	login?(state: DesktopLogin): void;
	state(state: DesktopState): void;
	update?(update: DesktopUpdate): void;
	permission(
		tool: string,
		input: unknown,
		scope?: { sessionId: string; turnId: string },
		signal?: AbortSignal,
	): Promise<boolean>;
}

export class DesktopRuntime {
	private readonly accounts: AccountManager;
	private readonly runner: ConversationRunner;
	private readonly imports: SessionImports;
	private readonly updates: DesktopUpdates;
	readonly store: DesktopStore;
	readonly login: DesktopLoginManager;
	private readonly host: RuntimeHost;
	private saving = false;

	private readonly bridge?: DesktopEngineBridge;
	private readonly hiddenChanges = new Map<string, Set<string>>();
	private readonly timelineAvailability = new Map<string, boolean>();
	private readonly usage = new AccountUsageService();
	private globalEvents: Promise<void> = Promise.resolve();
	private initialized = false;
	private readonly externalActive = new Set<string>();
	private readonly approvals: ApprovalPresenter;
	private selectedSessionId?: string;
	constructor(
		directory: string,
		host: RuntimeHost,
		engine?: DesktopEngine,
		catalog: AccountCatalogLoader = loadAccountCatalog,
		discoveryRoots?: { provider: "codex" | "claude"; path?: string }[],
		bridge = new DesktopEngineBridge(directory),
	) {
		this.store = new DesktopStore(directory);
		this.host = host;
		this.accounts = new AccountManager(
			{
				state: () => this.store.state,
				replaceState: (state) => {
					this.store.state = state;
				},
				busy: () => !!this.runner.abort,
				publish: () => this.publish(),
			},
			catalog,
		);
		this.login = new DesktopLoginManager(
			directory,
			(state) => this.host.login?.(state),
			(account) => this.accounts.save(account),
		);
		if (!engine) this.bridge = bridge;
		this.approvals = new ApprovalPresenter(
			(approval, sessionId, signal) =>
				this.host.permission(approval.tool, approval.input, { sessionId, turnId: approval.turnId }, signal),
			(sessionId, approvalId, allowed) => bridge.respond(sessionId, approvalId, allowed),
		);
		this.runner = new ConversationRunner({
			state: () => this.store.state,
			append: (session, action) => this.store.append(session, action),
			save: (ids) => this.store.save(ids),
			execute:
				engine ??
				((session, account, prompt, abort, callbacks) => bridge.run(session, account, prompt, abort, callbacks)),
			catalog,
			journalEvents: !!this.bridge,
			permission: (tool, input, scope, signal) => this.host.permission(tool, input, scope, signal),
			stream: (session, actions) => this.updates.stream(session, actions),
			streamEvent: (session, event, length) => this.updates.streamEvent(session, event, length),
			refreshChanges: (project) => this.refreshChangeFilter(project),
			timelineUnavailable: (project) => {
				this.timelineAvailability.set(project, false);
			},
			publish: (settled) => this.publish(settled),
		});
		this.imports = new SessionImports(
			{
				state: () => this.store.state,
				publicState: () => this.publicState(),
				emit: () => this.host.state(this.publicState()),
				synchronize: () => this.synchronizeGlobal(),
				save: () => this.store.save(),
				publish: () => this.publish(),
				hasService: !!this.bridge,
				running: () => !!this.runner.abort,
				saving: () => this.saving,
				setSaving: (value) => {
					this.saving = value;
				},
				append: (session, action) => this.store.append(session, action),
			},
			discoveryRoots,
		);
		this.updates = new DesktopUpdates({
			ready: () => this.initialized,
			running: () => !!this.runner.abort,
			externalBusy: () => [...this.externalActive][0],
			state: () => this.store.state,
			publicState: (actions) => this.publicState(actions),
			save: (ids) => this.store.save(ids),
			emit: (state) => this.host.state(state),
			update: this.host.update ? (update) => this.host.update!(update) : undefined,
		});
	}
	/** Refresh metadata only; source conversations are read when opened. */
	refreshSessions(force = true): Promise<void> {
		return this.imports.refreshSessions(force);
	}
	async initialize(): Promise<void> {
		await this.store.load();
		const previousAccounts = JSON.stringify(this.store.state.accounts);
		await Promise.all(
			this.store.state.sessions
				.filter((session) => session.importedFrom?.provider === "codex")
				.map(async (session) => {
					try {
						const presentation = await this.imports.importer.presentation(session);
						if (presentation.internal) this.imports.internalSessions.add(session.id);
						for (const [id, channel] of presentation.channels) {
							this.imports.importedChannels.set(id, channel);
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
					if (event.sessionId === this.store.state.busySession && this.runner.abort) return;
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
						if (["created", "selection", "workspace"].includes(event.data.type)) await this.publish();
						return;
					}
					const length = session.actions.length;
					projectEvents(session, [event]);
					session.relayLedgerSequence = event.sequence;
					this.updates.streamEvent(session, event, length);
				})
				.catch((error: unknown) => {
					process.stderr.write(`Relay projection failure: ${String(error)}\n`);
				});
		});
		await this.synchronizeGlobal();
		await Promise.allSettled(
			this.store.state.accounts
				.filter(
					(account) => !account.identityKey && (account.engine === "claude" || account.provider === "openai-codex"),
				)
				.map(async (account) => {
					const catalog = await this.accounts.load(account);
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
			if (global.turns.some((turn) => !turn.taskId && turn.status === "running")) this.externalActive.add(session.id);
			else this.externalActive.delete(session.id);
			for (const approval of global.approvals) this.approvals.update(session.id, approval);
		});
		mergeDuplicateAccounts(this.store.state);
		if (!this.runner.abort) this.store.state.busySession = [...this.externalActive][0];
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
	private publicState(actionFilter?: Set<DesktopAction>): DesktopState {
		return desktopState(
			{
				state: this.store.state,
				incremental: !!this.host.update,
				externalSessions: this.imports.externalSessions,
				internalSessions: this.imports.internalSessions,
				importedChannels: this.imports.importedChannels,
				discovery: this.imports.discovery,
				discoveryWarnings: this.imports.discoveryWarnings,
				timelineAvailability: this.timelineAvailability,
				hiddenChanges: this.hiddenChanges,
				selectedSessionId: this.selectedSessionId,
				localSessionId: (entry) => this.imports.localSessionId(entry),
			},
			actionFilter,
		);
	}
	private async publish(settled = false): Promise<void> {
		this.updates.flushStream();
		if (settled) {
			this.runner.abort = undefined;
			this.runner.switching = false;
			this.store.state.busySession = [...this.externalActive][0];
		}
		this.updates.clearPersistence();
		if (!this.runner.abort) this.store.state.busySession = [...this.externalActive][0];
		try {
			await this.bridge?.recordNotes(this.store.state);
			delete this.store.state.persistenceError;
			await this.store.save();
		} catch (error) {
			this.store.state.persistenceError = `Desktop state is unsaved: ${error instanceof Error ? error.message : String(error)}`;
			throw error;
		} finally {
			if (this.initialized) this.host.state(this.publicState());
		}
	}

	private async publishSelection(session: DesktopSession): Promise<void> {
		const account = this.store.state.accounts.find((account) => account.id === session.accountId);
		if (this.store.state.busySession !== session.id) await this.bridge?.select(session, account);
		await this.publish();
	}

	async command(command: DesktopCommand): Promise<DesktopResult> {
		if (command.type === "retry_save") {
			await this.publish();
			return this.publicState();
		}
		if (command.type === "recovery")
			return { recovery: (await this.bridge?.recovery(this.store.session(command.sessionId).project)) ?? [] };
		if (command.type === "reconcile") {
			if (!this.bridge) throw new Error("Recovery requires the shared service");
			await this.bridge.reconcile(command.sessionId, command.turnId, command.description);
			await this.synchronizeGlobal();
			await this.publish();
			return this.publicState();
		}
		if (command.type === "refresh_sessions") {
			await this.imports.refreshSessions(command.force ?? true);
			return this.publicState();
		}
		if ("sessionId" in command && !this.store.state.sessions.some((session) => session.id === command.sessionId)) {
			const source = this.imports.externalSessions.find(
				(source) => this.imports.localSessionId(source) === command.sessionId,
			);
			if (!source) throw new Error("Session is no longer available. Refresh the session list.");
			const result = await this.imports.queuedImport(source.id, undefined, true);
			if ("importedSessionId" in result) return this.command({ ...command, sessionId: result.importedSessionId });
		}
		if (command.type === "session_load") {
			this.selectedSessionId = command.sessionId;
			return this.publicState();
		}

		const timelineResult = await timelineCommands(
			{
				session: (id) => this.store.session(id),
				running: () => !!this.runner.abort,
				saving: () => this.saving,
				setSaving: (value) => {
					this.saving = value;
				},
				timelineAvailability: this.timelineAvailability,
				snapshotAction,
				publish: () => this.publish(),
			},
			command,
		);
		if (timelineResult !== undefined) return timelineResult;
		const workspaceResult = await workspaceCommands(
			{
				session: (id) => this.store.session(id),
				append: (session, action) => this.store.append(session, action),
				running: () => !!this.runner.abort,
				saving: () => this.saving,
				setSaving: (value) => {
					this.saving = value;
				},
				timelineAvailability: this.timelineAvailability,
				snapshotAction,
				refreshChanges: (project) => this.refreshChangeFilter(project),
				publish: () => this.publish(),
				publicState: () => this.publicState(),
				emit: (state) => this.host.state(state),
				saveFile: this.bridge
					? (session, path, expected, content) => this.bridge!.saveFile(session, path, expected, content)
					: undefined,
			},
			command,
		);
		if (workspaceResult !== undefined) return workspaceResult;
		if (command.type === "session_permissions") {
			if (this.runner.abort || this.saving) throw new Error("Stop the current run before changing permissions");
			if (!["ask", "auto-approve", "full-access", "read-only"].includes(command.mode))
				throw new Error("Unknown permission mode");
			this.store.session(command.sessionId).permissionMode = command.mode;
			await this.publish();
			return this.publicState();
		}
		if (command.type === "external_sessions") {
			const result = await this.imports.importer.list(command.provider, command.path);
			for (const item of result.items)
				item.importedSessionId = this.store.state.sessions.find(
					(session) =>
						session.importedFrom?.provider === item.provider && session.importedFrom.sessionId === item.sessionId,
				)?.id;
			return result;
		}
		if (command.type === "external_preview") return this.imports.importer.preview(command.sourceId);
		if (command.type === "import_session") return this.imports.queuedImport(command.sourceId, command.project);

		if (command.type === "cancel") {
			this.runner.cancelled = true;
			this.runner.switching = false;
			this.runner.abort?.abort();
			if (!this.runner.abort && this.store.state.busySession) await this.bridge?.cancel(this.store.state.busySession);
			return this.publicState();
		}
		if (command.type === "state") return this.publicState();
		const accountResult = await accountCommands(
			{
				state: () => this.store.state,
				session: (id) => this.store.session(id),
				append: (session, action) => this.store.append(session, action),
				running: () => !!this.runner.abort,
				accounts: this.accounts,
				usage: this.usage,
				login: this.login,
				switchRun: () => {
					this.runner.switching = true;
					this.runner.abort?.abort();
				},
				publish: () => this.publish(),
				publishSelection: (session) => this.publishSelection(session),
				publicState: () => this.publicState(),
			},
			command,
		);
		if (accountResult !== undefined) return accountResult;

		if (command.type === "review") {
			const session = this.store.session(command.sessionId);
			const action = await snapshotAction(session, command.actionId);
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
			if (this.runner.abort || this.saving)
				throw new Error("Another run or save is in progress. Wait before starting a new run.");
			const session = this.store.session(command.sessionId);
			let text: string;
			let review: DesktopAction | undefined;
			let reviewDirectory: string | undefined;
			if (command.type === "review_snapshot") {
				({ review, text, reviewDirectory } = await prepareReview(session, command.actionId));
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
			if (this.runner.abort || this.saving) {
				if (reviewDirectory) await rm(reviewDirectory, { recursive: true, force: true });
				throw new Error("Another session is running");
			}
			this.runner.abort = new AbortController();
			this.runner.cancelled = false;
			this.store.state.busySession = session.id;
			if (!review) {
				if (!session.actions.some((a) => a.kind === "user")) session.name = text.slice(0, 48);
				this.store.append(session, { kind: "user", text });
			}
			try {
				await this.publish();
			} catch (error) {
				this.runner.abort = undefined;
				this.store.state.busySession = [...this.externalActive][0];
				if (reviewDirectory) await rm(reviewDirectory, { recursive: true, force: true });
				this.host.state(this.publicState());
				throw error;
			}
			void this.runner.run(session, text, this.runner.abort, review, reviewDirectory).catch((error: unknown) => {
				process.stderr.write(`Relay persistence failure: ${String(error)}\n`);
			});
			return this.publicState();
		}

		const sessionResult = await sessionCommands(
			{
				state: () => this.store.state,
				session: (id) => this.store.session(id),
				append: (session, action) => this.store.append(session, action),
				running: () => !!this.runner.abort,
				saving: () => this.saving,
				publish: () => this.publish(),
				publishSelection: (session) => this.publishSelection(session),
				publicState: () => this.publicState(),
			},
			command,
		);
		if (sessionResult !== undefined) return sessionResult;
		if (this.runner.abort) throw new Error("Stop the current run before changing projects or accounts");

		await this.publish();
		return this.publicState();
	}
}
