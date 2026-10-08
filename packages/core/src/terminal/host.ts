import { randomUUID } from "node:crypto";
import type { ImageContent } from "pi-ai";
import { createLocalBashOperations, type ExtensionContext, type ExtensionFactory } from "pi-sdk";
import { Type } from "typebox";
import type {
	AttachmentReference,
	DelegationResult,
	PermissionMode,
	RelaySession,
	RuntimeEvent,
	TurnInput,
} from "../contracts.ts";
import { ApprovalPresenter } from "../desktop/approvals.ts";
import { turnText } from "../handoffs/context.ts";
import { PermissionGate } from "../permissions/gate.ts";
import type { RelayClient } from "../service/client.ts";
import { imageMediaType } from "../sessions/artifacts.ts";
import { NativeTerminal } from "./native.ts";

/** Only public lifecycle hooks; published pi owns prompts, tools, compaction, and UI. */
export function terminalHost(
	client: Pick<RelayClient, "request" | "onControl" | "onDisconnect" | "subscribe">,
	sessionId: string,
	profile: string,
	permissionMode: PermissionMode,
	navigate?: (manager: ExtensionContext["sessionManager"]) => Promise<string>,
): ExtensionFactory {
	return (pi) => {
		const native = new NativeTerminal(client, pi, () => sessionId, permissionMode);
		let turnId: string | undefined;
		let context: ExtensionContext | undefined;
		let readPaths: string[] = [];
		let gate = new PermissionGate();
		let failed = false;
		let nativeError = false;
		let shell: AbortController | undefined;
		let settled = Promise.resolve();
		let settle: (() => void) | undefined;
		const presenter = new ApprovalPresenter(
			async (approval, _sessionId, signal) =>
				context?.hasUI
					? context.ui.confirm("Relay approval", `${approval.tool}\n${JSON.stringify(approval.input)}`, {
							signal,
							timeout: Math.max(1, approval.expiresAt - Date.now()),
						})
					: false,
			async (sessionId, approvalId, allowed) => {
				await client.request({ type: "approval", sessionId, approvalId, allowed });
			},
		);
		pi.on("session_start", async (_event, ctx) => {
			pi.appendEntry("relay-product-session", { sessionId });
			await native.initialize(ctx, profile);
		});
		pi.on("session_tree", async (_event, ctx) => {
			if (!navigate) throw new Error("Relay tree navigation requires a session router");
			sessionId = await navigate(ctx.sessionManager);
			pi.appendEntry("relay-product-session", { sessionId });
			await native.initialize(ctx, profile);
			ctx.ui.notify(`Relay branch ${sessionId}. Workspace files retain their current state.`, "info");
		});
		pi.on("input", async (event, ctx) => {
			if (await native.input(event, ctx)) return { action: "handled" };
			if (failed) throw new Error("Relay execution unavailable; reconnect and inspect");
			return { action: "continue" };
		});
		pi.on("context", async (event) => ({
			messages: event.messages.filter(
				(message) => message.role !== "custom" || message.customType !== "relay-native-display",
			),
		}));
		pi.on("session_before_switch", async () => (native.busy ? { cancel: true } : undefined));
		pi.on("session_before_fork", async () => (native.busy ? { cancel: true } : undefined));
		pi.on("session_before_tree", async () => (native.busy ? { cancel: true } : undefined));
		const abort = () => {
			presenter.close();
			gate.cancel();
			shell?.abort();
			if (turnId) {
				try {
					context?.abort();
				} catch {
					/* A replaced native context cannot be used. The service quarantines disconnects. */
				}
			}
		};
		const delegated = new Set<string>();
		const approvals = client.subscribe((event) => {
			if (event.sessionId !== sessionId) return;
			if (event.data.type === "task" && event.data.task.parentTurnId === turnId) delegated.add(event.data.task.id);
			if (
				event.data.type === "approval" &&
				(event.data.approval.turnId === turnId ||
					(event.data.approval.taskId && delegated.has(event.data.approval.taskId))) &&
				context?.hasUI
			) {
				presenter.update(sessionId, event.data.approval);
			}
		});
		const publish = async (event: RuntimeEvent) => {
			if (!turnId) throw new Error("Relay execution lease is inactive");
			try {
				await client.request({ type: "host_event", turnId, event });
			} catch (error) {
				failed = true;
				gate.cancel();
				context?.abort();
				throw error;
			}
		};
		const control = client.onControl((control) => {
			if (control.turnId !== turnId) return;
			if (control.type === "cancel") abort();
			else gate.respond(control.approvalId, control.allowed);
		});
		const disconnect = client.onDisconnect(() => {
			failed = true;
			abort();
		});
		const finish = async (status: "completed" | "cancelled" | "failed" | "unknown") => {
			if (!turnId) return;
			const id = turnId;
			gate.cancel();
			presenter.close();
			try {
				const actual = await client.request({
					type: "host_finish",
					turnId: id,
					status: failed ? "unknown" : status,
				});
				if (actual === "unknown") {
					failed = true;
					context?.abort();
					context?.ui.notify(
						"Relay quarantined this workspace. Verify execution and reconcile before continuing.",
						"error",
					);
				}
			} finally {
				turnId = undefined;
				settle?.();
			}
		};
		const begin = async (prompt: string, ctx: ExtensionContext, images: ImageContent[] = []) => {
			if (turnId || failed) throw new Error("Prior Relay execution has not settled; reconnect and inspect");
			if (!ctx.model) throw new Error("Choose a pi model");
			context = ctx;
			gate = new PermissionGate();
			nativeError = false;
			settled = new Promise<void>((resolve) => {
				settle = resolve;
			});
			const id = randomUUID();
			turnId = id;
			try {
				const attachmentIds: string[] = [];
				if (images.length && !((await client.request({ type: "get", sessionId })) as RelaySession).ephemeral) {
					for (const image of images) {
						if (!imageMediaType(image.mimeType)) throw new Error("Unsupported portable image media type");
						const attachment = (await client.request({
							type: "attach",
							sessionId,
							mediaType: image.mimeType,
							data: image.data,
							description: "Pi terminal image attachment",
						})) as AttachmentReference;
						attachmentIds.push(attachment.id);
					}
				}
				const input = (await client.request({
					type: "host_start",
					sessionId,
					turnId: id,
					nativeId: ctx.sessionManager.getSessionId(),
					nativeFile: ctx.sessionManager.getSessionFile(),
					text: prompt,
					selection: {
						backend: "pi",
						profile,
						model: ctx.model.id,
						options: { provider: ctx.model.provider, thinking: ctx.thinkingLevel },
					},
					permissionMode,
					attachmentIds,
				})) as TurnInput;
				readPaths = input.readPaths ?? [];
				return input;
			} catch (error) {
				failed = true;
				gate.cancel();
				ctx.abort();
				throw error;
			}
		};
		pi.on("before_agent_start", async (event, ctx) => {
			const input = await begin(event.prompt, ctx, event.images);
			return {
				message: {
					customType: "relay-handoff",
					content: turnText("", input.handoff),
					display: false,
					details: { handoff: input.handoff, sessionId },
				},
			};
		});
		pi.on("tool_call", async (event, ctx) => {
			if (!turnId || failed) return { block: true, reason: "Relay lease unavailable" };
			const emit = async (update: RuntimeEvent) => {
				await publish(update);
			};
			if (
				event.toolName !== "relay_delegate_task" &&
				!(await gate.check(permissionMode, ctx.cwd, event.toolName, event.input, emit, readPaths))
			)
				return { block: true, reason: "Denied by Relay" };
			await publish({ type: "tool_start", id: event.toolCallId, name: event.toolName, input: event.input });
		});
		pi.on("tool_result", async (event) => {
			if (turnId)
				await publish({
					type: "tool_end",
					id: event.toolCallId,
					name: event.toolName,
					output: { content: event.content, details: event.details },
					failed: event.isError,
				});
		});
		pi.on("message_end", async (event) => {
			if (turnId && event.message.role === "custom" && event.message.customType === "relay-handoff")
				await publish({ type: "accepted" });
			if (!turnId || event.message.role !== "assistant") return;
			nativeError = !!event.message.errorMessage;
			await publish({
				type: "text",
				id: String(event.message.timestamp),
				text: event.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
				complete: true,
			});
			await publish({
				type: "usage",
				usage: {
					input: event.message.usage.input,
					output: event.message.usage.output,
					costUsd: event.message.usage.cost.total,
				},
			});
		});
		pi.on("message_update", async (event) => {
			if (turnId && event.message.role === "assistant" && event.assistantMessageEvent.type === "text_delta")
				await publish({
					type: "text",
					id: String(event.message.timestamp),
					text: event.assistantMessageEvent.delta,
					complete: false,
				});
		});
		pi.on("tool_execution_update", async (event) => {
			if (turnId)
				await publish({ type: "tool_progress", id: event.toolCallId, text: JSON.stringify(event.partialResult) });
		});
		pi.on("agent_settled", async (event) => {
			await finish(event.aborted ? "cancelled" : nativeError ? "failed" : "completed");
		});
		pi.on("session_compact", async () => {
			if (turnId)
				await publish({ type: "compaction", description: "Pi native compaction; Relay product history retained" });
		});
		pi.on("user_bash", async (event, ctx) => {
			const previous = settled;
			const operations = createLocalBashOperations({ shellPath: pi.getSettings().shellPath });
			return {
				operations: {
					exec: async (command, cwd, options) => {
						await previous;
						await begin(
							event.excludeFromContext
								? "User shell command (excluded from model context)"
								: `User shell command: ${event.command}`,
							ctx,
						);
						const id = randomUUID();
						let started = false;
						shell = new AbortController();
						try {
							if (permissionMode === "read-only")
								throw new Error("Read-only session cannot execute shell commands");
							await publish({
								type: "tool_start",
								id,
								name: "bash",
								input: event.excludeFromContext ? { excludedFromContext: true } : { command },
							});
							started = true;
							const result = await operations.exec(command, cwd, {
								...options,
								signal: options.signal ? AbortSignal.any([options.signal, shell.signal]) : shell.signal,
							});
							await publish({
								type: "tool_end",
								id,
								name: "bash",
								output: { exitCode: result.exitCode, excludedFromContext: event.excludeFromContext },
								failed: result.exitCode !== 0,
							});
							await finish(
								options.signal?.aborted || shell.signal.aborted
									? "cancelled"
									: result.exitCode === 0
										? "completed"
										: "failed",
							);
							return result;
						} catch (error) {
							await finish(started ? "unknown" : "failed").catch(() => {});
							throw error;
						} finally {
							shell = undefined;
						}
					},
				},
			};
		});
		pi.on("session_shutdown", async (_event, ctx) => {
			await native.close();
			if (turnId) {
				gate.cancel();
				ctx.abort();
				await finish("unknown").catch(() => {});
			}
			control();
			disconnect();
			approvals();
			presenter.close();
		});
		pi.registerTool({
			name: "relay_delegate_task",
			label: "Delegate task",
			description:
				"Delegate a complete bounded browser/computer task to a user-configured Relay worker. Use a worker ID from workers.json; the parent pauses until the worker settles.",
			parameters: Type.Object({ workerId: Type.String(), objective: Type.String() }),
			executionMode: "sequential",
			execute: async (_id, args) => {
				if (!turnId) throw new Error("Relay execution inactive");
				const result = (await client.request({
					type: "host_delegate",
					turnId,
					request: { workerId: args.workerId, objective: args.objective },
				})) as DelegationResult;
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		});
		pi.registerCommand("relay-session", {
			description: "Show this global Relay session ID",
			handler: async (_args, ctx) => {
				ctx.ui.notify(sessionId, "info");
			},
		});
		pi.registerCommand("relay-switch", {
			description: "Switch this global session: codex|claude|pi MODEL [PROVIDER]",
			handler: async (args, ctx) => {
				await ctx.waitForIdle();
				const [backend, model, provider] = args.trim().split(/\s+/);
				if (backend === "pi") {
					const selected = model
						? ctx.modelRegistry.find(provider ?? ctx.model?.provider ?? "", model)
						: ctx.model;
					if (!selected || !(await pi.setModel(selected)))
						throw new Error("Choose an authenticated pi provider/model");
					await native.select(
						{
							backend,
							model: selected.id,
							profile,
							options: { provider: selected.provider, thinking: ctx.thinkingLevel },
						},
						ctx,
					);
				} else {
					if (backend !== "codex" && backend !== "claude")
						throw new Error("Use codex, claude, or pi and an optional model/provider");
					await native.select({ backend, model: model ?? "", profile: "" }, ctx);
				}
			},
		});
		pi.registerCommand("relay-cancel", {
			description: "Cancel this Relay session and its workers",
			handler: async () => {
				await native.cancel();
			},
		});
	};
}
