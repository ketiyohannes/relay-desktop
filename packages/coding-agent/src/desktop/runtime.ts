import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { expandTildePath, getAgentDir } from "../config.ts";
import { ReadOnlyAuthStorage } from "../core/auth-storage.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { type AccountCatalogLoader, loadAccountCatalog } from "./accounts.ts";
import { isChangePath } from "./change-filter.ts";
import { CodexAuthStorage } from "./codex-auth.ts";
import { AccountExhaustedError, type EngineCallbacks, runClaude, runPi } from "./engines.ts";
import { projectHistory } from "./history.ts";
import { DesktopLoginManager } from "./login.ts";
import { searchCode } from "./search.ts";
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
} from "./types.ts";
import { AccountUsageService } from "./usage.ts";
import { browseDirectory, editorFile, saveEditorFile, workspaceView } from "./workspace.ts";

export interface RuntimeHost {
	login?(state: DesktopLogin): void;
	state(state: DesktopState): void;
	permission(tool: string, input: unknown): Promise<boolean>;
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
	private readonly transcripts;
	private readonly engine: DesktopEngine;
	private readonly catalog: AccountCatalogLoader;
	private readonly hiddenChanges = new Map<string, Set<string>>();
	private readonly usage = new AccountUsageService();
	constructor(
		directory: string,
		host: RuntimeHost,
		engine?: DesktopEngine,
		catalog: AccountCatalogLoader = loadAccountCatalog,
	) {
		this.catalog = catalog;
		this.store = new DesktopStore(directory);
		this.host = host;
		this.login = new DesktopLoginManager(
			directory,
			(state) => this.host.login?.(state),
			async (account) => {
				this.store.state.accounts.push(account);
				try {
					await this.publish();
				} catch (error) {
					this.store.state.accounts = this.store.state.accounts.filter((entry) => entry.id !== account.id);
					throw error;
				}
			},
		);
		this.transcripts = this.store.claudeTranscripts();
		this.engine =
			engine ??
			((session, account, prompt, abort, callbacks) =>
				account.engine === "claude"
					? runClaude(session, account, prompt, abort, this.transcripts, callbacks)
					: runPi(session, account, prompt, abort, callbacks));
	}
	async initialize(): Promise<void> {
		await this.store.load();
		await Promise.all(
			[...new Set(this.store.state.sessions.map((session) => session.project))].map((project) =>
				this.refreshChangeFilter(project),
			),
		);
		this.host.state(this.publicState());
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
		return {
			...this.store.state,
			sessions: this.store.state.sessions.map((session) => ({
				...session,
				actions: session.actions.map((action) =>
					action.files
						? {
								...action,
								files: action.files.filter(
									(path) => isChangePath(path) && !this.hiddenChanges.get(session.project)?.has(path),
								),
							}
						: action,
				),
			})),
		};
	}
	private async publish(): Promise<void> {
		await this.store.save();
		this.host.state(this.publicState());
	}
	private async snapshotAction(session: DesktopSession, id: string): Promise<DesktopAction | undefined> {
		const local = session.actions.find((action) => action.id === id);
		if (local || !id.startsWith("history:")) return local;
		const history = await projectHistory(new DesktopTimeline(session.project, session.id));
		return history.groups
			.flatMap((group) => [...(group.action ? [group.action] : []), ...group.events])
			.find((action) => action.id === id);
	}
	async command(command: DesktopCommand): Promise<DesktopResult> {
		if (command.type === "history")
			return projectHistory(new DesktopTimeline(this.store.session(command.sessionId).project, command.sessionId));
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
				let capturing = true;
				try {
					const baseline = await timeline.checkpoint("Before manual edit");
					if (baseline.snapshot !== baseline.previous)
						this.store.append(session, { kind: "checkpoint", text: "Before manual edit", ...baseline });
				} catch {
					capturing = false;
				}
				const file = await saveEditorFile(session.project, command.path, command.expected, command.content);
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
				} else file.warning = "Saved. Timeline recording requires a writable Git repository.";
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
			return {
				accounts: results.map((result, index) => ({
					accountId: accounts[index].id,
					...(result.status === "fulfilled"
						? { catalog: result.value }
						: { error: "Connection check failed. Retry or sign in again." }),
				})),
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
				await this.publish();
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
			if (command.engine === "claude")
				return this.catalog({
					id: "",
					name: "Claude",
					engine: "claude",
					provider: "",
					model: "",
					configDir: command.configDir || "",
				});
			const configDir = expandTildePath(
				command.configDir || (command.credentialSource === "codex" ? join(homedir(), ".codex") : getAgentDir()),
			);
			const credentials =
				command.credentialSource === "codex"
					? new CodexAuthStorage(configDir)
					: new ReadOnlyAuthStorage(join(configDir, "auth.json"));
			const stored = new Set((await credentials.list()).map((entry) => entry.providerId));
			const runtime = await ModelRuntime.create({
				credentials,
				modelsPath: command.credentialSource === "codex" ? null : join(configDir, "models.json"),
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
			await this.publish();
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
		}
		if (command.type === "account") {
			const account = { ...command.account, configDir: expandTildePath(command.account.configDir) };
			if (!["claude", "pi"].includes(account.engine) || !account.name.trim()) throw new Error("Invalid account");
			if (account.configDir && !(await stat(account.configDir)).isDirectory())
				throw new Error("Account config directory does not exist");
			if (account.engine === "pi" && (!account.provider || !account.model))
				throw new Error("Pi needs a provider and model ID");
			if (account.credentialSource === "codex" && (account.engine !== "pi" || account.provider !== "openai-codex"))
				throw new Error("Codex credentials require Pi's openai-codex provider");
			const index = this.store.state.accounts.findIndex((a) => a.id === account.id);
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
			if (this.abort) throw new Error("Stop the current run before changing accounts");
			if (index < 0) this.store.state.accounts.push({ ...account, id: randomUUID() });
			else this.store.state.accounts[index] = account;
		}
		await this.publish();
		return this.publicState();
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
		let timelineEnabled = true;
		let watcher: FSWatcher | undefined;
		let observation: ReturnType<typeof setTimeout> | undefined;
		let observationWork: Promise<void> = Promise.resolve();
		const callbacks: EngineCallbacks = {
			readOnly: !!review,
			permission: async (tool, input) => {
				if (!reviewDirectory) return this.host.permission(tool, input);
				if (!["read", "grep", "find", "ls", "Read", "Grep", "Glob"].includes(tool)) return false;
				const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
				const path =
					typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : ".";
				try {
					const local = relative(await realpath(reviewDirectory), await realpath(resolve(reviewDirectory, path)));
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
			text: async (_id, content, complete) => {
				if (!content && !assistant) return;
				if (!assistant)
					assistant = this.store.append(session, {
						kind: review ? "review" : "assistant",
						text: "",
						status: "running",
						...(review ? { snapshot: review.snapshot, previous: review.previous } : {}),
					});
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
						text: name,
						toolId: id,
						input: JSON.stringify(input, null, 2),
						status: "running",
					});
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
				} catch (error) {
					timelineEnabled = false;
					this.store.append(session, {
						kind: "error",
						text: `Timeline unavailable: ${String(error)}. Open a Git repository to capture file history.`,
					});
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
			this.store.append(session, { kind: "error", text: error instanceof Error ? error.message : String(error) });
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
			if (reviewDirectory) await rm(reviewDirectory, { recursive: true, force: true });
			delete this.store.state.busySession;
			this.abort = undefined;
			this.switching = false;
			await this.publish();
		}
	}
}
