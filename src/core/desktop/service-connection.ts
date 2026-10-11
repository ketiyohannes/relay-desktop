import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { accountSelection } from "../accounts/selection.ts";
import type { DesktopAccount } from "../accounts/types.ts";
import { ApprovalPresenter } from "../permissions/presenter.ts";
import type { RuntimeEvent, RuntimeSelection } from "../runtimes/types.ts";
import { RelayClient, RelayDisconnectedError } from "../service/client.ts";
import { validateSelection } from "../service/protocol.ts";
import {
	AccountExhaustedError,
	type EngineCallbacks,
	UncertainExecutionError,
} from "../sessions/conversation-types.ts";
import { projectEvents, publicHistory } from "../sessions/desktop-projection.ts";
import type { LedgerEvent, ProductNote, RecoveryEntry, RelaySession } from "../sessions/types.ts";
import type { EditorFile } from "../workspace/types.ts";
import type { DesktopSession, DesktopState } from "./types.ts";

type DesktopClient = Pick<RelayClient, "request" | "subscribe" | "onDisconnect">;

/** Presentation bridge only. Execution and durable history belong to the application service. */
export class DesktopEngineBridge {
	private readonly directory: string;
	private client?: Promise<DesktopClient>;
	private readonly connect: (directory: string) => Promise<DesktopClient>;
	private readonly notes = new Map<string, string>();
	private readonly observers = new Set<(event: LedgerEvent) => void>();
	constructor(directory: string, connect: (directory: string) => Promise<DesktopClient> = RelayClient.connect) {
		this.directory = process.env.RELAY_APP_DIR || join(directory, "app");
		this.connect = connect;
	}
	private async connected(): Promise<DesktopClient> {
		if (!this.client) {
			const attempt = this.connect(this.directory);
			this.client = attempt;
			void attempt.then(
				(client) => {
					client.subscribe((event) => {
						for (const observer of this.observers) observer(event);
					});
					client.onDisconnect(() => {
						if (this.client === attempt) this.client = undefined;
					});
				},
				() => {
					if (this.client === attempt) this.client = undefined;
				},
			);
		}
		return this.client;
	}
	async select(session: DesktopSession, account?: DesktopAccount): Promise<void> {
		const client = await this.connected();
		const selection: RuntimeSelection = account
			? accountSelection({ ...account, model: session.models?.[account.id] ?? account.model })
			: { backend: "codex", model: "", profile: "" };
		const global = (await client.request({
			type: "create",
			after: Number.MAX_SAFE_INTEGER,
			sessionId: session.id,
			workspace: session.project,
			selection,
			name: session.name,
		})) as RelaySession;
		if (global.workspace !== session.project)
			await client.request({ type: "workspace", sessionId: session.id, workspace: session.project });
		if (account) await client.request({ type: "select", sessionId: session.id, selection });
	}
	async saveFile(session: DesktopSession, path: string, expected: string, content: string): Promise<EditorFile> {
		return (await this.connected()).request({
			type: "edit",
			sessionId: session.id,
			operationId: randomUUID(),
			path,
			expected,
			content,
		}) as Promise<EditorFile>;
	}
	async recordNotes(state: DesktopState): Promise<void> {
		const client = await this.connected();
		for (const session of state.sessions) {
			const pending = session.actions.filter((action) =>
				["review", "checkpoint", "switch", "error"].includes(action.kind),
			);
			if (!pending.length || !session.project) continue;
			const account = state.accounts.find((account) => account.id === session.accountId);
			try {
				await client.request({
					type: "create",
					after: Number.MAX_SAFE_INTEGER,
					sessionId: session.id,
					workspace: session.project,
					name: session.name,
					selection: account ? accountSelection(account) : { backend: "codex", model: "", profile: "" },
				});
			} catch (error) {
				if (error instanceof Error && /ENOENT/.test(error.message)) continue;
				throw error;
			}
			for (const action of pending) {
				const note: ProductNote = {
					id: action.id,
					kind: action.kind as ProductNote["kind"],
					text: action.text,
					...(action.status && action.status !== "unknown" ? { status: action.status } : {}),
					...(action.snapshot ? { snapshot: action.snapshot } : {}),
					...(action.previous ? { previous: action.previous } : {}),
					...(action.files ? { files: action.files } : {}),
					...(action.toolId ? { toolId: action.toolId } : {}),
					...(action.rootCommit === undefined ? {} : { rootCommit: action.rootCommit }),
				};
				const key = `${session.id}:${action.id}`;
				const serialized = JSON.stringify(note);
				if (this.notes.get(key) === serialized) continue;
				this.notes.set(key, serialized);
				try {
					await client.request({ type: "note", sessionId: session.id, note });
				} catch (error) {
					this.notes.delete(key);
					throw error;
				}
			}
		}
	}
	async observe(listener: (event: LedgerEvent) => void): Promise<() => void> {
		this.observers.add(listener);
		await this.connected();
		return () => this.observers.delete(listener);
	}
	async respond(sessionId: string, approvalId: string, allowed: boolean): Promise<void> {
		await (await this.connected()).request({ type: "approval", sessionId, approvalId, allowed });
	}
	async cancel(sessionId: string): Promise<void> {
		await (await this.connected()).request({ type: "cancel", sessionId });
	}
	async recovery(workspace: string): Promise<RecoveryEntry[]> {
		return (await this.connected()).request({ type: "recovery", workspace }) as Promise<RecoveryEntry[]>;
	}
	async reconcile(sessionId: string, turnId: string, description: string): Promise<void> {
		await (await this.connected()).request({ type: "reconcile", sessionId, turnId, description });
	}
	async synchronize(
		state: DesktopState,
		execution?: (session: DesktopSession, global: RelaySession) => void,
	): Promise<void> {
		const client = await this.connected();
		for (const session of state.sessions) {
			if (session.id === state.busySession || session.relayLedgerSequence !== undefined) continue;
			const account = state.accounts.find((account) => account.id === session.accountId);
			try {
				const global = (await client.request({
					type: "create",
					sessionId: session.id,
					workspace: session.project,
					selection: account
						? accountSelection({ ...account, model: session.models?.[account.id] ?? account.model })
						: { backend: "codex", model: "", profile: "" },
					name: session.name,
				})) as RelaySession;
				if (
					!global.turns.length &&
					session.relayLedgerSequence === undefined &&
					!global.events.some((event) => event.data.type === "import" && event.data.source === `desktop:${session.id}`)
				) {
					await client.request({ type: "import", sessionId: session.id, data: publicHistory(session) });
					session.relayLedgerSequence = (
						(await client.request({ type: "get", sessionId: session.id })) as RelaySession
					).events.at(-1)?.sequence;
				}
			} catch (error) {
				if (error instanceof Error && /ENOENT/.test(error.message)) continue;
				throw error;
			}
		}
		const sessions = (await client.request({ type: "list" })) as Omit<RelaySession, "events">[];
		for (const global of sessions) {
			if (global.ephemeral) continue;
			if (global.id.startsWith("review-") || global.id === state.busySession) continue;
			let local = state.sessions.find((session) => session.id === global.id);
			if (local && !local.accountId && !global.natives.length) continue;
			const match = state.accounts.find((account) =>
				[account.configDir, ...(account.equivalentProfiles || [])].some(
					(profile) =>
						JSON.stringify(
							validateSelection(
								accountSelection({
									...account,
									configDir: profile,
									runtimeSelection: account.runtimeSelection ? { ...account.runtimeSelection, profile } : undefined,
									model: global.selection.model,
								}),
							),
						) === JSON.stringify(global.selection),
				),
			);
			const account = match ?? {
				id: `runtime-${createHash("sha256").update(JSON.stringify(global.selection)).digest("hex").slice(0, 20)}`,
				name:
					global.selection.backend === "pi"
						? global.selection.options.provider
						: global.selection.backend === "claude"
							? "Claude"
							: "Codex",
				engine: global.selection.backend === "claude" ? ("claude" as const) : ("pi" as const),
				configDir: global.selection.profile,
				provider:
					global.selection.backend === "codex"
						? "openai-codex"
						: global.selection.backend === "pi"
							? global.selection.options.provider
							: "",
				model: global.selection.model,
				runtimeSelection: global.selection,
				credentialSource: global.selection.backend === "codex" ? ("codex" as const) : ("pi" as const),
			};
			if (!match) state.accounts.push(account);
			if (!local) {
				local = {
					id: global.id,
					project: global.workspace,
					name: global.name,
					updated: global.updated,
					accountId: account.id,
					autoSwitch: true,
					actions: [],
				};
				state.sessions.push(local);
			}
			const full = (await client.request({
				type: "get",
				sessionId: global.id,
				after: local.relayLedgerSequence ?? 0,
			})) as RelaySession;
			execution?.(local, full);
			projectEvents(
				local,
				full.events.filter((event) => event.sequence > (local.relayLedgerSequence ?? 0)),
			);
			local.relayLedgerSequence = full.events.at(-1)?.sequence ?? local.relayLedgerSequence;
			local.accountId = account.id;
			local.models = { ...local.models, [account.id]: full.selection.model };
			local.project = full.workspace;
			local.updated = full.updated;
			if (!state.projects.includes(full.workspace)) state.projects.push(full.workspace);
		}
	}
	async run(
		session: DesktopSession,
		account: DesktopAccount,
		prompt: string,
		abort: AbortController,
		callbacks: EngineCallbacks,
	): Promise<void> {
		const client = await this.connected();
		const selection = accountSelection(account);
		const sessionId = callbacks.review ? `review-${randomUUID()}` : session.id;
		let global = (await client.request({
			type: "create",
			sessionId,
			workspace: session.project,
			selection,
			name: session.name,
			parentSessionId: callbacks.review?.parentSessionId,
			purpose: callbacks.review ? "review" : undefined,
		})) as RelaySession;
		if (global.workspace !== session.project)
			await client.request({ type: "workspace", sessionId, workspace: session.project });
		await client.request({ type: "select", sessionId, selection });
		if (!global.events.some((event) => event.data.type === "import") && !global.turns.length) {
			const latest = session.actions.at(-1);
			const actions =
				latest?.kind === "user" && latest.text === prompt ? session.actions.slice(0, -1) : session.actions;
			await client.request({ type: "import", sessionId, data: publicHistory({ ...session, actions }) });
		}
		global = (await client.request({ type: "get", sessionId })) as RelaySession;
		if (global.turns.some((turn) => turn.status === "unknown"))
			throw new UncertainExecutionError(
				"Interrupted native execution requires reconciliation. Use Relay CLI reconcile after verifying tool effects.",
			);
		let pending: Promise<void> = Promise.resolve();
		let failure: unknown;
		let completion: Extract<RuntimeEvent, { type: "done" }> | undefined;
		const latest = session.actions.at(-1);
		const turnId =
			sessionId === session.id && latest?.kind === "user" && latest.text === prompt ? latest.id : randomUUID();
		const delegated = new Set<string>();
		const approvals = new ApprovalPresenter(
			(approval, sessionId, signal) =>
				callbacks.permission(approval.tool, approval.input, { sessionId, turnId: approval.turnId }, signal),
			async (sessionId, approvalId, allowed) => {
				await client.request({ type: "approval", sessionId, approvalId, allowed });
			},
		);
		const update = async (event: LedgerEvent) => {
			if (event.sessionId !== sessionId) return;
			const data = event.data;
			if (data.type === "task" && data.task.parentTurnId === turnId) delegated.add(data.task.id);
			if (
				data.type === "approval" &&
				(data.approval.turnId === turnId || (data.approval.taskId && delegated.has(data.approval.taskId)))
			) {
				approvals.update(sessionId, data.approval);
			}
			if (callbacks.event) await callbacks.event(event);
			if (data.type !== "runtime" || data.turnId !== turnId || data.taskId) return;
			const runtime = data.event;
			if (runtime.type === "text" && !callbacks.event)
				await callbacks.text(`native:${data.nativeRecordId}:${runtime.id}`, runtime.text, runtime.complete);
			if (runtime.type === "tool_start") {
				await callbacks.checkpoint("Before tool", runtime.id);
				if (!callbacks.event)
					await callbacks.tool(`tool:${data.nativeRecordId}:${runtime.id}`, runtime.name, runtime.input);
			}
			if (runtime.type === "tool_progress" && !callbacks.event)
				await callbacks.toolProgress?.(`tool:${data.nativeRecordId}:${runtime.id}`, "Running", runtime.text);
			if (runtime.type === "tool_end") {
				if (!callbacks.event)
					await callbacks.tool(
						`tool:${data.nativeRecordId}:${runtime.id}`,
						runtime.name,
						undefined,
						runtime.output,
						runtime.failed,
					);
				await callbacks.checkpoint(`After ${runtime.name}`, runtime.id);
			}
			if (runtime.type === "done") completion = runtime;
		};
		const unsubscribe = client.subscribe((event) => {
			pending = pending.then(() => update(event));
			void pending.catch((error: unknown) => {
				failure = error;
				void client.request({ type: "cancel", sessionId });
			});
		});
		const cancel = () => {
			void client.request({ type: "cancel", sessionId }).catch(() => {});
		};
		abort.signal.addEventListener("abort", cancel, { once: true });
		try {
			if (abort.signal.aborted) throw new Error("Cancelled");
			const status = await client.request({
				type: "submit",
				sessionId,
				turnId,
				text: prompt,
				permissionMode: callbacks.readOnly ? "read-only" : (session.permissionMode ?? "ask"),
			});
			await pending;
			if (sessionId === session.id)
				session.relayLedgerSequence = ((await client.request({ type: "get", sessionId })) as RelaySession).events.at(
					-1,
				)?.sequence;
			if (status === "unknown")
				throw new UncertainExecutionError(
					"Execution outcome unknown; verify native processes and tool effects before continuing",
				);
			if (failure) throw failure;
			if (completion?.quotaExhausted) throw new AccountExhaustedError(completion.error || "Account quota exhausted");
			if (status !== "completed")
				throw new Error(completion?.error || (status === "cancelled" ? "Cancelled" : "Native runtime failed"));
		} catch (error) {
			if (error instanceof RelayDisconnectedError) throw new UncertainExecutionError(error.message);
			throw error;
		} finally {
			approvals.close();
			unsubscribe();
			abort.signal.removeEventListener("abort", cancel);
		}
	}
}
