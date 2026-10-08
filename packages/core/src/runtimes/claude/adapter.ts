import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	type HookCallback,
	type Options,
	type Query,
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
import { workerReport, workerReportSchema } from "../../tasks/report.ts";
import { stopProcessGroup } from "../process-group.ts";

export type ClaudeQuery = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export class ClaudeAdapter implements RuntimeAdapter {
	readonly backend = "claude";
	private readonly invoke: ClaudeQuery;
	constructor(invoke: ClaudeQuery = query) {
		this.invoke = invoke;
	}
	async discover(_selection: RuntimeSelection): Promise<Capability> {
		return {
			resume: true,
			cancel: "interrupt",
			approvals: "tool-hook",
			compaction: "native",
			tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
			mcp: true,
			limitations: [
				"SDK 0.3.291; native tools and persistence remain SDK-owned.",
				"PreToolUse coordinates Relay policy even when native rules auto-approve.",
				"Tool filtering is not an OS sandbox.",
				"Browser/computer infrastructure must be configured separately.",
				"Subscription login/usage product features require provider authorization.",
			],
		};
	}
	async open(input: OpenInput): Promise<RuntimeConnection> {
		return new ClaudeConnection(input, this.invoke);
	}
}

class ClaudeConnection implements RuntimeConnection {
	private readonly input: OpenInput;
	private readonly invoke: ClaudeQuery;
	private readonly abort = new AbortController();
	private readonly gate = new PermissionGate();
	private request?: Query;
	private child?: ChildProcessWithoutNullStreams;
	private exited?: Promise<void>;
	private readonly tasks = new Set<string>();
	private cancelled = false;
	nativeId?: string;
	constructor(input: OpenInput, invoke: ClaudeQuery) {
		this.input = input;
		this.invoke = invoke;
		this.nativeId = input.record.nativeId;
	}
	async submit(input: TurnInput, emit: (event: RuntimeEvent) => Promise<void>): Promise<void> {
		const selection = this.input.record.selection;
		if (selection.backend !== "claude") throw new Error("Invalid Claude selection");
		const approvals = new Map<string, Promise<boolean>>();
		const approve = (id: string, name: string, args: unknown) => {
			let answer = approvals.get(id);
			if (!answer) {
				answer = this.gate.check(
					input.permissionMode,
					this.input.record.workspace,
					name,
					args,
					emit,
					this.input.readPaths,
				);
				approvals.set(id, answer);
			}
			return answer;
		};
		const pre: HookCallback = async (event) => {
			if (event.hook_event_name !== "PreToolUse") return {};
			if (!(await approve(event.tool_use_id, event.tool_name, event.tool_input)))
				return {
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: "Denied by Relay policy",
					},
				};
			await emit({ type: "tool_start", id: event.tool_use_id, name: event.tool_name, input: event.tool_input });
			return {};
		};
		const post: HookCallback = async (event) => {
			if (event.hook_event_name !== "PostToolUse" && event.hook_event_name !== "PostToolUseFailure") return {};
			await emit({
				type: "tool_end",
				id: event.tool_use_id,
				name: event.tool_name,
				output: event.hook_event_name === "PostToolUse" ? event.tool_response : event.error,
				failed: event.hook_event_name === "PostToolUseFailure",
			});
			approvals.delete(event.tool_use_id);
			return {};
		};
		const mcpServers = selection.options?.mcp
			? Object.fromEntries(
					Object.entries(selection.options.mcp).map(([name, server]) => [
						name,
						{
							command: server.command,
							args: server.args,
							env: Object.fromEntries(
								(server.envKeys ?? []).flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
							),
						},
					]),
				)
			: undefined;
		let stopInput!: () => void;
		const inputStopped = new Promise<void>((resolve) => {
			stopInput = resolve;
		});
		async function* messages(): AsyncGenerator<SDKUserMessage> {
			const images = await attachmentImages(input.attachments);
			yield {
				type: "user",
				session_id: "",
				parent_tool_use_id: null,
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: turnText(input.text, input.handoff) + (await attachmentText(input.attachments)),
						},
						...images.map((image) => ({
							type: "image" as const,
							source: { type: "base64" as const, data: image.data, media_type: image.mimeType },
						})),
					],
				},
			};
			await inputStopped;
		}
		let accepted = false;
		let result = false;
		let exhausted = false;
		let messageId: string = randomUUID();
		const options: Options = {
			persistSession: this.input.persist !== false,
			cwd: this.input.record.workspace,
			resume: this.nativeId,
			model: selection.model || undefined,
			abortController: this.abort,
			includePartialMessages: true,
			permissionMode: "default",
			settingSources:
				selection.options?.projectInstructions === false || input.permissionMode === "read-only"
					? []
					: ["user", "project", "local"],
			env: {
				...process.env,
				...(selection.profile
					? {
							CLAUDE_CONFIG_DIR: selection.profile,
							CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined,
							ANTHROPIC_API_KEY: undefined,
							ANTHROPIC_AUTH_TOKEN: undefined,
							CLAUDE_CODE_OAUTH_TOKEN: undefined,
						}
					: {}),
				CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
			},
			...(input.permissionMode === "read-only"
				? {
						tools: ["Read", "Grep", "Glob"],
						disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "Agent", "Task"],
					}
				: {}),
			mcpServers,
			maxTurns: selection.options?.maxTurns,
			...(this.input.record.role === "worker"
				? { outputFormat: { type: "json_schema" as const, schema: workerReportSchema } }
				: {}),
			hooks: {
				PreToolUse: [{ hooks: [pre] }],
				PostToolUse: [{ hooks: [post] }],
				PostToolUseFailure: [{ hooks: [post] }],
			},
			canUseTool: async (name, args, context) =>
				(await approve(context.toolUseID, name, args))
					? { behavior: "allow", updatedInput: args }
					: { behavior: "deny", message: "Denied by Relay" },
			spawnClaudeCodeProcess: (spawnOptions) => {
				const child = spawn(spawnOptions.command, spawnOptions.args, {
					cwd: spawnOptions.cwd,
					env: spawnOptions.env,
					stdio: ["pipe", "pipe", "pipe"],
					detached: process.platform !== "win32",
				});
				this.child = child;
				this.exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
				child.stderr.on("data", () => {});
				const abort = () => child.kill("SIGTERM");
				spawnOptions.signal.addEventListener("abort", abort, { once: true });
				child.once("close", () => spawnOptions.signal.removeEventListener("abort", abort));
				return child;
			},
		};
		try {
			if (this.cancelled) {
				await emit({ type: "done", status: "cancelled" });
				return;
			}
			this.request = this.invoke({ prompt: messages(), options });
			for await (const message of this.request) {
				if ("session_id" in message && message.session_id && message.session_id !== this.nativeId) {
					this.nativeId = message.session_id;
					await emit({ type: "native_session", nativeId: this.nativeId });
				}
				if (!accepted && ["assistant", "stream_event", "result"].includes(message.type)) {
					await emit({ type: "accepted" });
					accepted = true;
				}
				if (message.type === "system") {
					if (message.subtype === "task_started") this.tasks.add(message.task_id);
					if (message.subtype === "task_notification") this.tasks.delete(message.task_id);
					if (message.subtype === "mirror_error") throw new Error("Claude transcript mirror failed");
					if (message.subtype === "compact_boundary")
						await emit({
							type: "compaction",
							description: "Claude compacted native context; Relay ledger retained",
						});
				}
				if (message.type === "rate_limit_event")
					exhausted =
						message.rate_limit_info.status === "rejected" &&
						!["allowed", "allowed_warning"].includes(message.rate_limit_info.overageStatus ?? "");
				await this.message(
					message,
					emit,
					(id) => {
						messageId = id;
					},
					() => messageId,
				);
				if (message.type === "result") {
					result = true;
					if (message.subtype === "success" && message.structured_output !== undefined)
						await emit({ type: "worker_result", report: workerReport(message.structured_output) });
					await emit({
						type: "usage",
						usage: {
							input: message.usage.input_tokens,
							output: message.usage.output_tokens,
							costUsd: message.total_cost_usd,
						},
					});
					await emit({
						type: "done",
						status: this.cancelled ? "cancelled" : message.is_error ? "failed" : "completed",
						error: message.is_error
							? message.subtype === "success"
								? message.result
								: message.errors.join("\n")
							: undefined,
						quotaExhausted: message.is_error && exhausted,
					});
					break;
				}
			}
			if (!result)
				await emit({
					type: "done",
					status: this.cancelled ? "cancelled" : "unknown",
					error: "Claude ended without a native result",
					quotaExhausted: exhausted,
				});
		} finally {
			stopInput();
			this.gate.cancel();
		}
	}
	private async message(
		message: SDKMessage,
		emit: (event: RuntimeEvent) => Promise<void>,
		setId: (id: string) => void,
		getId: () => string,
	): Promise<void> {
		if (message.type === "stream_event" && !message.parent_tool_use_id) {
			const event = message.event;
			if (event.type === "message_start") setId(event.message.id);
			if (event.type === "content_block_delta" && event.delta.type === "text_delta")
				await emit({ type: "text", id: getId(), text: event.delta.text, complete: false });
		}
		if (message.type === "assistant" && !message.parent_tool_use_id)
			await emit({
				type: "text",
				id: message.message.id,
				text: message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
				complete: true,
			});
		if (message.type === "tool_progress")
			await emit({
				type: "tool_progress",
				id: message.tool_use_id,
				text: `Running ${Math.round(message.elapsed_time_seconds)}s`,
			});
	}
	async respond(id: string, allowed: boolean): Promise<"sent" | "expired"> {
		return this.gate.respond(id, allowed);
	}
	async cancel(): Promise<"requested" | "unknown"> {
		this.cancelled = true;
		this.gate.cancel();
		try {
			for (const task of this.tasks) await this.request?.stopTask(task);
			await this.request?.interrupt();
			this.abort.abort();
			return "requested";
		} catch {
			this.abort.abort();
			return "unknown";
		}
	}
	async release(): Promise<"settled" | "unknown"> {
		this.gate.cancel();
		for (const task of this.tasks) await this.request?.stopTask(task).catch(() => {});
		this.request?.close();
		if (!this.child) return this.tasks.size ? "unknown" : "settled";
		return stopProcessGroup(this.child, this.exited!);
	}
}
