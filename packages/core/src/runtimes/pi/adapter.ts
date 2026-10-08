import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "pi-sdk";
import { Type } from "typebox";
import type {
	Capability,
	OpenInput,
	RuntimeAdapter,
	RuntimeConnection,
	RuntimeEvent,
	RuntimeSelection,
	TurnInput,
} from "../../contracts.ts";
import { attachmentImages, attachmentText } from "../../handoffs/attachments.ts";
import { turnText } from "../../handoffs/context.ts";
import { PermissionGate } from "../../permissions/gate.ts";
import { noTrustUI, resolveTrust } from "./trust.ts";

export class PiAdapter implements RuntimeAdapter {
	readonly backend = "pi";
	private readonly models: typeof ModelRuntime.create;
	constructor(models: typeof ModelRuntime.create = ModelRuntime.create) {
		this.models = models;
	}
	async discover(_selection: RuntimeSelection): Promise<Capability> {
		return {
			resume: true,
			cancel: "abort",
			approvals: "tool-hook",
			compaction: "native",
			tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "relay_delegate_task"],
			mcp: false,
			limitations: [
				"Published pi-coding-agent 1.1.0 (MIT).",
				"Built-in MCP/codemode/tool-search/llama.cpp remain disabled; user extensions are retained.",
				"Trusted extensions run application code; permission hooks are not an OS sandbox.",
				"Rich extension UI belongs to the pi terminal host; it cannot be serialized to desktop.",
			],
		};
	}
	async open(input: OpenInput): Promise<RuntimeConnection> {
		if (input.record.selection.backend !== "pi") throw new Error("Invalid pi selection");
		const connection = new PiConnection(input, this.models);
		await connection.initialize();
		return connection;
	}
}

class PiConnection implements RuntimeConnection {
	private readonly input: OpenInput;
	private readonly models: typeof ModelRuntime.create;
	private readonly gate = new PermissionGate();
	private session?: AgentSession;
	private emit?: (event: RuntimeEvent) => Promise<void>;
	private cancelled = false;
	private messageId = "";
	private pending: Promise<void> = Promise.resolve();
	private eventFailure?: unknown;
	nativeId?: string;
	constructor(input: OpenInput, models: typeof ModelRuntime.create) {
		this.input = input;
		this.models = models;
	}
	async initialize(): Promise<void> {
		const selection = this.input.record.selection;
		if (selection.backend !== "pi") throw new Error("Invalid pi selection");
		const agentDir = selection.profile || join(homedir(), ".pi", "agent");
		const modelRuntime = await this.models({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		const settingsManager = SettingsManager.create(this.input.record.workspace, agentDir, { projectTrusted: false });
		const relayPolicy: ExtensionFactory = (pi) => {
			pi.on("tool_call", async (event) => {
				if (!this.emit || this.cancelled) return { block: true, reason: "Relay execution inactive" };
				// Delegation enforces inherited policy in the application and worker adapter.
				if (
					event.toolName !== "relay_delegate_task" &&
					!(await this.gate.check(
						this.input.permissionMode,
						this.input.record.workspace,
						event.toolName,
						event.input,
						this.emit,
						this.input.readPaths,
					))
				)
					return { block: true, reason: "Denied by Relay policy" };
				await this.emit({ type: "tool_start", id: event.toolCallId, name: event.toolName, input: event.input });
			});
			pi.on("tool_result", async (event) => {
				await this.emit?.({
					type: "tool_end",
					id: event.toolCallId,
					name: event.toolName,
					output: { content: event.content, details: event.details },
					failed: event.isError,
				});
			});
		};
		const services = await createAgentSessionServices({
			cwd: this.input.record.workspace,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoaderReloadOptions: {
				resolveProjectTrust: ({ extensionsResult }) =>
					resolveTrust({
						cwd: this.input.record.workspace,
						profile: agentDir,
						defaultTrust: settingsManager.getDefaultProjectTrust(),
						extensions: extensionsResult,
						context: noTrustUI(this.input.record.workspace),
					}),
			},
			resourceLoaderOptions: {
				disabledBuiltinExtensions: ["llama.cpp", "mcp", "codemode", "tool-search"],
				extensionFactories: [{ name: "relay-policy", factory: relayPolicy }],
				// Public hooks run in order. Relay policy follows user argument mutations.
				extensionsOverride: (base) => ({
					...base,
					extensions: [
						...base.extensions.filter((extension) => extension.path !== "<inline:relay-policy>"),
						...base.extensions.filter((extension) => extension.path === "<inline:relay-policy>"),
					],
				}),
			},
		});
		if (services.diagnostics.some((diagnostic) => diagnostic.type === "error"))
			throw new Error(services.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		const model = services.modelRuntime.getModel(selection.options.provider, selection.model);
		if (!model)
			throw new Error(
				`Unknown pi model ${selection.options.provider}/${selection.model}${services.resourceLoader
					.getExtensions()
					.errors.map((error) => `\nExtension ${error.path}: ${error.error}`)
					.join("")}`,
			);
		let sessionManager: SessionManager;
		if (this.input.persist === false) sessionManager = SessionManager.inMemory(this.input.record.workspace);
		else if (this.input.record.nativeFile) {
			await readFile(this.input.record.nativeFile);
			sessionManager = SessionManager.open(this.input.record.nativeFile, undefined, this.input.record.workspace);
			if (sessionManager.getSessionId() !== this.input.record.nativeId)
				throw new Error("Native journal identity changed");
		} else if (this.input.record.nativeId) {
			const files = await readdir(this.input.nativeDirectory);
			const file = files.find((file) => file.endsWith(`_${this.input.record.nativeId}.jsonl`));
			if (!file) throw new Error("Pi native session missing; reset native mapping after reconciliation");
			const path = join(this.input.nativeDirectory, file);
			// Check a readable file before SessionManager.open (which creates a new session for absent files).
			await readFile(path);
			sessionManager = SessionManager.open(path, this.input.nativeDirectory, this.input.record.workspace);
		} else sessionManager = SessionManager.create(this.input.record.workspace, this.input.nativeDirectory);
		const delegate = this.input.delegate;
		const schema = Type.Object({
			workerId: Type.String(),
			objective: Type.String(),
		});
		const customTools = delegate
			? [
					{
						name: "relay_delegate_task",
						label: "Delegate task",
						description: `Delegate a bounded browser/computer task to a native Codex or Claude worker. Requires configured tools. Return evidence, effects, and final environment state. The parent pauses until the worker settles. Configured workers: ${JSON.stringify(this.input.workers ?? [])}`,
						parameters: schema,
						executionMode: "sequential" as const,
						execute: async (
							_id: string,
							args: { workerId: string; objective: string },
							signal: AbortSignal | undefined,
						) => {
							const result = await delegate(
								{ workerId: args.workerId, objective: args.objective },
								signal ?? new AbortController().signal,
							);
							return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
						},
					},
				]
			: [];
		const result = await createAgentSessionFromServices({
			services,
			model,
			thinkingLevel: selection.options.thinking,
			sessionManager,
			customTools,
			...(this.input.permissionMode === "read-only"
				? { tools: ["read", "grep", "find", "ls", "relay_delegate_task"] }
				: {}),
		});
		this.session = result.session;
		this.nativeId = sessionManager.getSessionId();
		await result.session.bindExtensions({
			mode: "rpc",
			abortHandler: () => {
				void result.session.abort();
			},
		});
		result.session.subscribe((event) => {
			this.pending = this.pending.then(() => this.event(event));
			void this.pending.catch((error: unknown) => {
				this.eventFailure = error;
				this.gate.cancel();
				void this.session?.abort();
			});
		});
	}
	private async event(event: AgentSessionEvent): Promise<void> {
		if (!this.emit) return;
		if (event.type === "message_start" && event.message.role === "assistant")
			this.messageId = String(event.message.timestamp);
		if (event.type === "message_start" && event.message.role === "user") await this.emit({ type: "accepted" });
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
			await this.emit({
				type: "text",
				id: this.messageId,
				text: event.assistantMessageEvent.delta,
				complete: false,
			});
		if (event.type === "message_end" && event.message.role === "assistant") {
			await this.emit({
				type: "text",
				id: String(event.message.timestamp),
				text: event.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
				complete: true,
			});
			await this.emit({
				type: "usage",
				usage: {
					input: event.message.usage.input,
					output: event.message.usage.output,
					costUsd: event.message.usage.cost.total,
				},
			});
		}
		if (event.type === "tool_execution_update")
			await this.emit({ type: "tool_progress", id: event.toolCallId, text: JSON.stringify(event.partialResult) });
		if (event.type === "compaction_end")
			await this.emit({
				type: "compaction",
				description: `Pi ${event.reason} compaction ${event.aborted ? "aborted" : "completed"}; Relay ledger retained`,
			});
	}
	async submit(input: TurnInput, emit: (event: RuntimeEvent) => Promise<void>): Promise<void> {
		if (!this.session) throw new Error("Pi session not initialized");
		this.emit = emit;
		if (this.cancelled) {
			await emit({ type: "done", status: "cancelled" });
			return;
		}
		if (input.handoff)
			await this.session.sendCustomMessage(
				{
					customType: "relay-handoff",
					content: turnText("", input.handoff),
					display: false,
					details: { handoff: input.handoff },
				},
				{ triggerTurn: false },
			);
		const images = await attachmentImages(input.attachments);
		if (images.length && !this.session.model?.input.includes("image")) {
			await emit({
				type: "done",
				status: "failed",
				error: "Selected pi model does not support image input; select a capable model",
			});
			return;
		}
		await this.session.prompt(input.text + (await attachmentText(input.attachments)), {
			expandPromptTemplates: true,
			source: "rpc",
			images: images.map((image) => ({ type: "image", ...image })),
		});
		await this.pending;
		if (this.eventFailure) throw this.eventFailure;
		const message = this.session.messages.at(-1);
		const error = message?.role === "assistant" ? message.errorMessage : undefined;
		await emit({
			type: "done",
			status: this.cancelled ? "cancelled" : error ? "failed" : "completed",
			error,
			quotaExhausted: error ? /(?:insufficient_quota|usage_limit_reached|out_of_credits)/i.test(error) : false,
		});
	}
	async respond(id: string, allowed: boolean): Promise<"sent" | "expired"> {
		return this.gate.respond(id, allowed);
	}
	async cancel(): Promise<"requested"> {
		this.cancelled = true;
		this.gate.cancel();
		await this.session?.abort();
		return "requested";
	}
	async release(): Promise<"settled"> {
		this.gate.cancel();
		await this.session?.abort();
		this.session?.dispose();
		return "settled";
	}
}
