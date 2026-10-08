import type {
	Capability,
	OpenInput,
	RuntimeAdapter,
	RuntimeConnection,
	RuntimeEvent,
	RuntimeSelection,
	TurnInput,
} from "../../contracts.ts";
import { attachmentText } from "../../handoffs/attachments.ts";
import { turnText } from "../../handoffs/context.ts";
import { imageMediaType } from "../../sessions/artifacts.ts";
import { workerReport, workerReportSchema } from "../../tasks/report.ts";
import { type CodexTransport, type RpcMessage, StdioCodexTransport } from "./transport.ts";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex protocol object");
	return value as Record<string, unknown>;
}
function string(value: unknown): string {
	if (typeof value !== "string") throw new Error("Invalid Codex string");
	return value;
}

/** Protocol subset verified against Codex 0.160.0; no dynamic-tools assumption. */
export class CodexAdapter implements RuntimeAdapter {
	readonly backend = "codex";
	private readonly transport: (profile: string) => CodexTransport;
	constructor(transport: (profile: string) => CodexTransport = (profile) => new StdioCodexTransport(profile)) {
		this.transport = transport;
	}
	async discover(_selection: RuntimeSelection): Promise<Capability> {
		return {
			resume: true,
			cancel: "interrupt",
			approvals: "native",
			compaction: "native",
			tools: ["commandExecution", "fileChange", "mcpToolCall"],
			mcp: true,
			limitations: [
				"Requires installed Codex App Server (verified 0.160.0).",
				"Native sandbox allows workspace operations; Relay prompts only on native approval requests.",
				"Browser/computer tools require explicitly configured MCP infrastructure.",
				"External detached processes are outside turn cancellation guarantees.",
			],
		};
	}
	async open(input: OpenInput): Promise<RuntimeConnection> {
		if (input.record.selection.backend !== "codex") throw new Error("Invalid Codex selection");
		const transport = this.transport(input.record.selection.profile);
		try {
			await transport.request("initialize", {
				clientInfo: { name: "relay", title: "Relay", version: "0.0.3" },
				capabilities: { experimentalApi: false },
			});
			transport.notify("initialized");
			const mcp = input.record.selection.options?.mcp;
			const config = mcp
				? Object.fromEntries(
						Object.entries(mcp).map(([name, server]) => [
							`mcp_servers.${name}`,
							{
								command: server.command,
								args: server.args,
								...(server.envKeys ? { env_vars: server.envKeys } : {}),
							},
						]),
					)
				: undefined;
			const params = {
				ephemeral: input.persist === false,
				cwd: input.record.workspace,
				model: input.record.selection.model || undefined,
				approvalPolicy:
					input.permissionMode === "read-only"
						? "never"
						: input.permissionMode === "ask"
							? "untrusted"
							: "on-request",
				approvalsReviewer: "user",
				sandbox: input.permissionMode === "read-only" ? "read-only" : "workspace-write",
				config,
			};
			const response = object(
				await transport.request(
					input.record.nativeId ? "thread/resume" : "thread/start",
					input.record.nativeId ? { ...params, threadId: input.record.nativeId, excludeTurns: true } : params,
				),
			);
			const nativeId = string(object(response.thread).id);
			return new CodexConnection(transport, nativeId, input);
		} catch (error) {
			await transport.close();
			throw error;
		}
	}
}

class CodexConnection implements RuntimeConnection {
	readonly nativeId: string;
	private readonly transport: CodexTransport;
	private readonly input: OpenInput;
	private turnId?: string;
	private emit?: (event: RuntimeEvent) => Promise<void>;
	private pending: Promise<void> = Promise.resolve();
	private finish?: () => void;
	private fail?: (error: Error) => void;
	private readonly approvals = new Map<string, { requestId: number | string; method: string }>();
	private readonly unsubscribe: () => void;
	private readonly disconnect: () => void;
	private cancelled = false;
	constructor(transport: CodexTransport, nativeId: string, input: OpenInput) {
		this.transport = transport;
		this.nativeId = nativeId;
		this.input = input;
		this.unsubscribe = transport.onMessage((message) => {
			this.pending = this.pending.then(() => this.handle(message));
			void this.pending.catch((error: unknown) =>
				this.fail?.(error instanceof Error ? error : new Error(String(error))),
			);
		});
		this.disconnect = transport.onDisconnect((error) => this.fail?.(error));
	}
	private async handle(message: RpcMessage): Promise<void> {
		if (!message.method || !this.emit) return;
		const params = object(message.params ?? {});
		if (params.threadId && params.threadId !== this.nativeId) return;
		if (message.id !== undefined) {
			if (
				message.method === "item/commandExecution/requestApproval" ||
				message.method === "item/fileChange/requestApproval"
			) {
				if (this.input.permissionMode === "read-only") {
					this.transport.respond(message.id, { decision: "decline" });
					return;
				}
				const id = `codex:${this.nativeId}:${message.id}`;
				this.approvals.set(id, { requestId: message.id, method: message.method });
				await this.emit({
					type: "approval",
					id,
					tool: message.method.includes("commandExecution") ? "bash" : "edit",
					input: params,
				});
				if (this.cancelled) await this.respond(id, false);
			} else {
				// Unknown server requests cannot silently authorize operations.
				this.transport.reject(message.id, `Unsupported Relay approval/input request: ${message.method}`);
				throw new Error(`Unsupported Codex server request: ${message.method}`);
			}
			return;
		}
		switch (message.method) {
			case "turn/started":
				this.turnId = string(object(params.turn).id);
				break;
			case "item/agentMessage/delta":
				await this.emit({ type: "text", id: string(params.itemId), text: string(params.delta), complete: false });
				break;
			case "item/commandExecution/outputDelta":
				await this.emit({ type: "tool_progress", id: string(params.itemId), text: string(params.delta) });
				break;
			case "item/started":
			case "item/completed": {
				const item = object(params.item);
				const type = string(item.type);
				const id = string(item.id);
				const complete = message.method === "item/completed";
				if (type === "agentMessage" && complete) {
					await this.emit({ type: "text", id, text: string(item.text), complete: true });
					if (this.input.record.role === "worker" && item.phase !== "commentary") {
						try {
							await this.emit({ type: "worker_result", report: workerReport(JSON.parse(string(item.text))) });
						} catch {
							/* Keep public text; application reports missing structured evidence. */
						}
					}
				}
				if (["commandExecution", "fileChange", "mcpToolCall"].includes(type)) {
					const name =
						type === "commandExecution"
							? "bash"
							: type === "fileChange"
								? "edit"
								: `${String(item.server)}:${String(item.tool)}`;
					if (!complete)
						await this.emit({
							type: "tool_start",
							id,
							name,
							input: item.command ?? item.changes ?? item.arguments,
						});
					else
						await this.emit({
							type: "tool_end",
							id,
							name,
							output: item.aggregatedOutput ?? item.changes ?? item.result ?? item.error ?? "",
							failed:
								item.status === "failed" ||
								item.status === "declined" ||
								(typeof item.exitCode === "number" && item.exitCode !== 0),
						});
				}
				if (type === "contextCompaction" && complete)
					await this.emit({
						type: "compaction",
						description: "Codex compacted its native context; Relay history retained",
					});
				break;
			}
			case "thread/tokenUsage/updated": {
				const total = object(object(params.tokenUsage).total);
				await this.emit({
					type: "usage",
					usage: Object.fromEntries(
						Object.entries(total).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
					),
				});
				break;
			}
			case "turn/completed": {
				const turn = object(params.turn);
				const status = turn.status;
				const error = turn.error ? object(turn.error) : undefined;
				await this.emit({
					type: "done",
					status: status === "completed" ? "completed" : status === "interrupted" ? "cancelled" : "failed",
					error: error ? String(error.message) : undefined,
				});
				this.finish?.();
				break;
			}
		}
	}
	async submit(input: TurnInput, emit: (event: RuntimeEvent) => Promise<void>): Promise<void> {
		this.emit = emit;
		const completed = new Promise<void>((resolve, reject) => {
			this.finish = resolve;
			this.fail = reject;
		});
		// Attach a handler before transport submission can disconnect.
		void completed.catch(() => {});
		const selection = this.input.record.selection;
		if (selection.backend !== "codex") throw new Error("Invalid Codex model");
		const response = object(
			await this.transport.request("turn/start", {
				threadId: this.nativeId,
				clientUserMessageId: input.id,
				input: [
					{
						type: "text",
						text: turnText(input.text, input.handoff) + (await attachmentText(input.attachments)),
						text_elements: [],
					},
					...(input.attachments ?? [])
						.filter((attachment) => imageMediaType(attachment.reference.mediaType))
						.map((attachment) => ({ type: "localImage", path: attachment.path })),
				],
				model: selection.model || undefined,
				effort: selection.options?.effort,
				...(this.input.record.role === "worker" ? { outputSchema: workerReportSchema } : {}),
				sandboxPolicy:
					input.permissionMode === "read-only"
						? { type: "readOnly", networkAccess: false }
						: {
								type: "workspaceWrite",
								writableRoots: [this.input.record.workspace],
								networkAccess: false,
								excludeTmpdirEnvVar: true,
								excludeSlashTmp: true,
							},
			}),
		);
		this.turnId = string(object(response.turn).id);
		await emit({ type: "accepted", nativeTurnId: this.turnId });
		if (this.cancelled) await this.cancel();
		await completed;
		await this.pending;
	}
	async respond(id: string, allowed: boolean): Promise<"sent" | "expired"> {
		const approval = this.approvals.get(id);
		if (!approval) return "expired";
		this.transport.respond(approval.requestId, { decision: allowed ? "accept" : "decline" });
		this.approvals.delete(id);
		return "sent";
	}
	async cancel(): Promise<"requested" | "unknown"> {
		this.cancelled = true;
		for (const id of this.approvals.keys()) await this.respond(id, false);
		if (!this.turnId) return "requested";
		try {
			await this.transport.request("turn/interrupt", { threadId: this.nativeId, turnId: this.turnId });
			return "requested";
		} catch {
			return "unknown";
		}
	}
	async release(): Promise<"settled" | "unknown"> {
		this.unsubscribe();
		this.disconnect();
		return this.transport.close();
	}
}
