import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, InputEvent } from "pi-sdk";
import { type KeybindingsConfig, KeybindingsManager, matchesKey } from "pi-tui";
import type {
	AttachmentReference,
	LedgerData,
	LedgerEvent,
	PermissionMode,
	RelaySession,
	RuntimeSelection,
} from "../contracts.ts";
import { ApprovalPresenter } from "../desktop/approvals.ts";
import type { RelayClient } from "../service/client.ts";
import { imageMediaType } from "../sessions/artifacts.ts";
import { PublicHistoryRenderer, replayEvents } from "../sessions/public-history.ts";
import { nativeHistory } from "./sessions.ts";

export const DEFAULT_APP_KEYBINDINGS = {
	"app.interrupt": { defaultKeys: "escape" as const, description: "Cancel active Relay execution" },
};

type NativeContext = Pick<ExtensionContext, "mode" | "hasUI"> & {
	ui: Pick<ExtensionUIContext, "confirm" | "notify" | "setWidget" | "setStatus" | "onTerminalInput">;
	sessionManager?: Pick<ExtensionContext["sessionManager"], "getBranch" | "getSessionId" | "getLeafId">;
};

function collectArtifacts(history: Extract<LedgerData, { type: "import" }>, entry: LedgerEvent): void {
	const data = entry.data;
	if (data.type === "runtime" && !data.taskId && data.event.type === "artifact") {
		history.artifacts ??= [];
		history.artifacts.push(data.event.artifact);
	}
	if (data.type === "task" && data.task.result) {
		history.artifacts ??= [];
		history.artifacts.push(...data.task.result.evidence);
		history.outcomes.push({
			eventId: entry.id,
			tool: "Relay delegated task",
			outcome: JSON.stringify(data.task.result),
			effect: data.task.status === "unknown" ? "unknown" : "completed",
		});
	}
}

/** A frontend controller: every native turn is submitted to the service, never to a Relay agent loop. */
export class NativeTerminal {
	private readonly client: Pick<RelayClient, "request" | "subscribe">;
	private readonly pi: Pick<ExtensionAPI, "sendMessage">;
	private readonly sessionId: () => string;
	private readonly permissionMode: PermissionMode;
	private context?: NativeContext;
	private running?: Promise<void>;
	private preparing = false;
	private preparationCancelled = false;
	private transcript = "";
	private history: Extract<LedgerData, { type: "import" }> = {
		type: "import",
		source: "",
		messages: [],
		outcomes: [],
	};
	private renderer = new PublicHistoryRenderer();
	private readonly approvals: ApprovalPresenter;
	private readonly unsubscribe: () => void;
	private inputSubscription?: () => void;
	private selection?: RuntimeSelection;
	constructor(
		client: Pick<RelayClient, "request" | "subscribe">,
		pi: Pick<ExtensionAPI, "sendMessage">,
		sessionId: () => string,
		permissionMode: PermissionMode,
	) {
		this.client = client;
		this.pi = pi;
		this.sessionId = sessionId;
		this.permissionMode = permissionMode;
		this.approvals = new ApprovalPresenter(
			async (approval, _id, signal) =>
				this.context?.hasUI
					? this.context.ui.confirm("Relay approval", `${approval.tool}\n${JSON.stringify(approval.input)}`, {
							signal,
							timeout: Math.max(1, approval.expiresAt - Date.now()),
						})
					: false,
			async (id, approvalId, allowed) => {
				await client.request({ type: "approval", sessionId: id, approvalId, allowed });
			},
		);
		this.unsubscribe = client.subscribe((entry) => {
			if (entry.sessionId !== this.sessionId()) return;
			if (entry.data.type === "selection") {
				this.selection = entry.data.selection;
				this.status();
			}
			if (!this.running) return;
			if (entry.data.type === "approval") this.approvals.update(entry.sessionId, entry.data.approval);
			collectArtifacts(this.history, entry);
			const data = entry.data;
			if (data.type === "user")
				this.history.messages.push({ id: entry.id, role: "user", text: data.text, attachments: data.attachments });
			if (data.type === "runtime" && !data.taskId) {
				if (data.event.type === "text" && data.event.complete)
					this.history.messages.push({ id: entry.id, role: "assistant", text: data.event.text });
				if (data.event.type === "tool_end")
					this.history.outcomes.push({
						eventId: entry.id,
						tool: data.event.name,
						outcome: JSON.stringify(data.event.output),
						effect: data.event.failed ? "unknown" : "completed",
					});
			}
			this.transcript += this.renderer.render(entry);
			this.context?.ui.setWidget("relay-native-stream", this.transcript.slice(-4000).split("\n").slice(-12));
		});
	}
	get busy(): boolean {
		return this.preparing || this.running !== undefined;
	}
	private status(): void {
		if (this.selection)
			this.context?.ui.setStatus(
				"relay-runtime",
				`Relay ${this.selection.backend}: ${this.selection.model || "default"}${this.busy ? " (running)" : ""}`,
			);
	}
	async initialize(ctx: NativeContext, profile: string): Promise<void> {
		this.inputSubscription?.();
		this.context = ctx;
		const snapshot = (await this.client.request({ type: "get", sessionId: this.sessionId() })) as RelaySession;
		this.selection = snapshot.selection;
		this.status();
		if (ctx.mode !== "tui") return;
		if (ctx.sessionManager) {
			const manager = ctx.sessionManager;
			const existing = nativeHistory({
				getSessionId: () => manager.getSessionId(),
				getLeafId: () => manager.getLeafId(),
				getBranch: () =>
					manager
						.getBranch()
						.filter((entry) => entry.type !== "custom_message" || entry.customType !== "relay-handoff"),
			});
			const shown = new Set([
				...existing.messages.map((message) => message.id),
				...existing.outcomes.map((outcome) => outcome.eventId),
			]);
			const shownArtifacts = new Set((existing.artifacts ?? []).map((artifact) => `${artifact.id}:${artifact.uri}`));
			const own = new Set(
				snapshot.natives
					.filter((record) => record.selection.backend === "pi" && record.nativeId === manager.getSessionId())
					.map((record) => record.id),
			);
			const renderer = new PublicHistoryRenderer();
			const history: Extract<LedgerData, { type: "import" }> = {
				type: "import",
				source: `relay:${snapshot.id}:replay`,
				messages: [],
				outcomes: [],
			};
			let display = "";
			for (const entry of replayEvents(snapshot)) {
				const data = entry.data;
				if (shown.has(entry.id)) continue;
				if (
					data.type === "user" &&
					snapshot.turns.some((turn) => turn.id === data.turnId && own.has(turn.nativeRecordId))
				)
					continue;
				if (data.type === "runtime" && own.has(data.nativeRecordId)) continue;
				if (data.type === "import") {
					const filtered = {
						...data,
						messages: data.messages.filter((message) => !shown.has(message.id)),
						outcomes: data.outcomes.filter((outcome) => !shown.has(outcome.eventId)),
						artifacts: data.artifacts?.filter((artifact) => !shownArtifacts.has(`${artifact.id}:${artifact.uri}`)),
					};
					history.messages.push(...filtered.messages);
					history.outcomes.push(...filtered.outcomes);
					history.artifacts ??= [];
					history.artifacts.push(...(filtered.artifacts ?? []));
					display += renderer.render({ ...entry, data: filtered });
					continue;
				}
				if (
					data.type === "runtime" &&
					data.event.type === "artifact" &&
					shownArtifacts.has(`${data.event.artifact.id}:${data.event.artifact.uri}`)
				)
					continue;
				collectArtifacts(history, entry);
				if (data.type === "user")
					history.messages.push({ id: entry.id, role: "user", text: data.text, attachments: data.attachments });
				if (data.type === "runtime" && !data.taskId) {
					if (data.event.type === "text" && data.event.complete)
						history.messages.push({ id: entry.id, role: "assistant", text: data.event.text });
					if (data.event.type === "tool_end")
						history.outcomes.push({
							eventId: entry.id,
							tool: data.event.name,
							outcome: JSON.stringify(data.event.output),
							effect: data.event.failed ? "unknown" : "completed",
						});
				}
				if (data.type !== "selection" && data.type !== "approval") display += renderer.render(entry);
			}
			if (history.messages.length || history.outcomes.length || history.artifacts?.length)
				this.pi.sendMessage(
					{
						customType: "relay-native-display",
						content: display,
						display: true,
						details: { sessionId: snapshot.id, history },
					},
					{ triggerTurn: false },
				);
		}
		let config: KeybindingsConfig = {};
		try {
			config = JSON.parse(await readFile(join(profile, "keybindings.json"), "utf8")) as KeybindingsConfig;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const keys = new KeybindingsManager(DEFAULT_APP_KEYBINDINGS, config);
		this.inputSubscription = ctx.ui.onTerminalInput((data) => {
			const binding = keys.getResolvedBindings()["app.interrupt"];
			const interrupts = Array.isArray(binding) ? binding : binding ? [binding] : [];
			if (!this.busy || !interrupts.some((key) => matchesKey(data, key))) return;
			void this.cancel().catch((error: unknown) => ctx.ui.notify(String(error), "error"));
			return { consume: true };
		});
	}
	async select(selection: RuntimeSelection, ctx: NativeContext): Promise<void> {
		if (this.busy) throw new Error("Cancel and wait for Relay execution before switching");
		this.context = ctx;
		await this.client.request({ type: "select", sessionId: this.sessionId(), selection });
		this.selection = selection;
		this.status();
		ctx.ui.notify(`Selected ${selection.backend}; continue in this terminal.`, "info");
	}
	async input(event: InputEvent, ctx: NativeContext): Promise<boolean> {
		// Preserve pi's own print/JSON/RPC protocols. Native interactive routing uses the shared service.
		if (ctx.mode !== "tui") return false;
		if (this.busy) {
			ctx.ui.notify("Relay execution active; cancel or wait before submitting another prompt.", "warning");
			return true;
		}
		this.preparing = true;
		this.preparationCancelled = false;
		try {
			const snapshot = (await this.client.request({ type: "get", sessionId: this.sessionId() })) as RelaySession;
			this.selection = snapshot.selection;
			this.context = ctx;
			this.status();
			if (this.selection.backend === "pi") return false;
			const attachmentIds: string[] = [];
			for (const image of event.images ?? []) {
				if (!imageMediaType(image.mimeType)) throw new Error("Unsupported native image media type");
				const attachment = (await this.client.request({
					type: "attach",
					sessionId: this.sessionId(),
					data: image.data,
					mediaType: image.mimeType,
					description: "Terminal image attachment",
				})) as AttachmentReference;
				attachmentIds.push(attachment.id);
			}
			if (this.preparationCancelled) return true;
			this.transcript = "";
			this.renderer = new PublicHistoryRenderer();
			const turnId = randomUUID();
			this.history = { type: "import", source: `relay:${this.sessionId()}:${turnId}`, messages: [], outcomes: [] };
			// Reserve the UI before the request can emit events.
			this.running = Promise.resolve();
			this.running = this.client
				.request({
					type: "submit",
					sessionId: this.sessionId(),
					turnId,
					text: event.text,
					permissionMode: this.permissionMode,
					attachmentIds,
				})
				.then((status) => {
					if (status === "unknown")
						ctx.ui.notify("Execution uncertain; inspect native effects before reconciliation.", "error");
				})
				.catch((error: unknown) => {
					ctx.ui.notify(String(error), "error");
				})
				.finally(() => {
					this.approvals.close();
					if (this.transcript)
						this.pi.sendMessage(
							{
								customType: "relay-native-display",
								content: this.transcript,
								display: true,
								details: { sessionId: this.sessionId(), turnId, history: this.history },
							},
							{ triggerTurn: false },
						);
					ctx.ui.setWidget("relay-native-stream", undefined);
					this.running = undefined;
					this.status();
				});
			this.status();
			return true;
		} finally {
			this.preparing = false;
			this.status();
		}
	}
	async cancel(): Promise<void> {
		if (this.preparing) this.preparationCancelled = true;
		const result = await this.client.request({ type: "cancel", sessionId: this.sessionId() });
		this.context?.ui.notify(
			`Cancellation ${String(result)}`,
			result === "unknown" || result === "unsupported" ? "warning" : "info",
		);
	}
	async waitForIdle(): Promise<void> {
		await this.running;
	}
	async close(): Promise<void> {
		this.inputSubscription?.();
		if (this.running) {
			await this.cancel();
			await this.running;
		}
		this.approvals.close();
		this.unsubscribe();
	}
}
