import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { OpenInput, RuntimeEvent } from "../../src/core/contracts.ts";
import { ClaudeAdapter, type ClaudeQuery } from "../../src/core/runtimes/claude/adapter.ts";
import { CodexAdapter } from "../../src/core/runtimes/codex/adapter.ts";
import type { CodexTransport, RpcMessage } from "../../src/core/runtimes/codex/transport.ts";

function input(backend: "codex" | "claude", workspace = "/project"): OpenInput {
	return {
		record: {
			id: "record",
			selection: { backend, model: "model", profile: "/profile" },
			workspace,
			branch: "main",
			role: "foreground",
			receivedThrough: 0,
			status: "available",
		},
		nativeDirectory: "/native",
		permissionMode: "ask",
	};
}

class MockTransport implements CodexTransport {
	readonly requests: { method: string; params: unknown }[] = [];
	readonly responses: { id: number | string; result: unknown }[] = [];
	private handler?: (message: RpcMessage) => void;
	private disconnect?: (error: Error) => void;
	closed = false;
	async request(method: string, params: unknown): Promise<unknown> {
		this.requests.push({ method, params });
		if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread" } };
		if (method === "turn/start") {
			queueMicrotask(() => {
				this.handler?.({
					method: "item/agentMessage/delta",
					params: { threadId: "thread", itemId: "message", delta: "Hello" },
				});
				this.handler?.({
					id: 7,
					method: "item/commandExecution/requestApproval",
					params: { threadId: "thread", turnId: "turn", itemId: "command", command: "echo hello" },
				});
			});
			return { turn: { id: "turn" } };
		}
		return {};
	}
	notify(): void {}
	reject(id: number | string, message: string): void {
		this.responses.push({ id, result: { error: message } });
	}
	respond(id: number | string, result: unknown): void {
		this.responses.push({ id, result });
		queueMicrotask(() => {
			this.handler?.({
				method: "item/completed",
				params: {
					threadId: "thread",
					item: {
						type: "commandExecution",
						id: "command",
						command: "echo hello",
						aggregatedOutput: "hello",
						exitCode: 0,
						status: "completed",
					},
				},
			});
			this.handler?.({
				method: "item/completed",
				params: { threadId: "thread", item: { type: "reasoning", id: "hidden", content: ["private"] } },
			});
			this.handler?.({
				method: "item/completed",
				params: { threadId: "thread", item: { type: "agentMessage", id: "message", text: "Hello" } },
			});
			this.handler?.({
				method: "turn/completed",
				params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
			});
		});
	}
	onMessage(handler: (message: RpcMessage) => void): () => void {
		this.handler = handler;
		return () => {
			this.handler = undefined;
		};
	}
	onDisconnect(handler: (error: Error) => void): () => void {
		this.disconnect = handler;
		return () => {
			this.disconnect = undefined;
		};
	}
	async close(): Promise<"settled"> {
		this.closed = true;
		return "settled";
	}
	fail(): void {
		this.disconnect?.(new Error("Disconnected"));
	}
}

test("Codex routes native JSON-RPC approval IDs, drops private reasoning, and does not use dynamic tools", async () => {
	const transport = new MockTransport();
	const adapter = new CodexAdapter(() => transport);
	const connection = await adapter.open(input("codex"));
	const events: RuntimeEvent[] = [];
	await connection.submit(
		{
			id: "operation",
			text: "Hello",
			permissionMode: "ask",
			attachments: [
				{
					path: "/images/fixture.png",
					reference: {
						id: "image",
						uri: "file:///images/fixture.png",
						description: "Fixture",
						bytes: 10,
						mediaType: "image/png",
					},
				},
			],
		},
		async (event) => {
			events.push(event);
			if (event.type === "approval") assert.equal(await connection.respond(event.id, true), "sent");
		},
	);
	assert.deepEqual(transport.responses, [{ id: 7, result: { decision: "accept" } }]);
	assert.equal(JSON.stringify(events).includes("private"), false);
	assert.equal(JSON.stringify(transport.requests).includes("dynamicTools"), false);
	assert.ok(JSON.stringify(transport.requests).includes('"type":"localImage","path":"/images/fixture.png"'));
	assert.ok(events.some((event) => event.type === "tool_end" && event.output === "hello"));
	assert.equal(await connection.release(), "settled");
	assert.equal(transport.closed, true);
});

test("Codex resumes only its own thread and scopes cancellation to the active turn", async () => {
	const transport = new MockTransport();
	const request = input("codex");
	request.record.nativeId = "existing";
	const connection = await new CodexAdapter(() => transport).open(request);
	await connection.submit({ id: "operation", text: "run", permissionMode: "read-only" }, async (event) => {
		if (event.type === "approval") await connection.respond(event.id, false);
	});
	assert.equal(await connection.cancel(), "requested");
	assert.ok(
		transport.requests.some(
			(request) =>
				request.method === "thread/resume" && (request.params as { threadId: string }).threadId === "existing",
		),
	);
	assert.deepEqual(transport.requests.find((request) => request.method === "turn/interrupt")?.params, {
		threadId: "thread",
		turnId: "turn",
	});
	await connection.release();
});

for (const mode of ["ask", "auto-approve", "full-access", "read-only"] as const) {
	test(`Codex maps ${mode} to native review and sandbox policy`, async () => {
		const transport = new MockTransport();
		const request = input("codex");
		request.permissionMode = mode;
		const connection = await new CodexAdapter(() => transport).open(request);
		let approvals = 0;
		await connection.submit({ id: "operation", text: "run", permissionMode: mode }, async (event) => {
			if (event.type === "approval") {
				approvals++;
				await connection.respond(event.id, false);
			}
		});
		const thread = transport.requests.find((entry) => entry.method === "thread/start")?.params as Record<
			string,
			unknown
		>;
		assert.equal(thread.approvalsReviewer, mode === "auto-approve" ? "auto_review" : "user");
		assert.equal(
			thread.approvalPolicy,
			mode === "ask" ? "untrusted" : mode === "auto-approve" ? "on-request" : "never",
		);
		assert.equal(
			thread.sandbox,
			mode === "full-access" ? "danger-full-access" : mode === "read-only" ? "read-only" : "workspace-write",
		);
		const turn = transport.requests.find((entry) => entry.method === "turn/start")?.params as {
			sandboxPolicy: { type: string };
		};
		assert.equal(
			turn.sandboxPolicy.type,
			mode === "full-access" ? "dangerFullAccess" : mode === "read-only" ? "readOnly" : "workspaceWrite",
		);
		assert.equal(approvals, mode === "ask" || mode === "auto-approve" ? 1 : 0);
		assert.deepEqual(transport.responses[0]?.result, { decision: mode === "full-access" ? "accept" : "decline" });
		await connection.release();
	});
}

function mockQuery(
	script: (options: Options, prompt: AsyncIterable<SDKUserMessage>) => AsyncGenerator<SDKMessage>,
	controls: { interrupted: number; closed: number },
): ClaudeQuery {
	return ({ options, prompt }) => {
		const stream = script(options, prompt);
		return Object.assign(stream, {
			interrupt: async () => {
				controls.interrupted++;
				return undefined;
			},
			close: () => {
				controls.closed++;
			},
			stopTask: async () => {},
		}) as unknown as Query;
	};
}
function result(): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "Done",
		session_id: "native-claude",
		uuid: "fixture",
		usage: { input_tokens: 1, output_tokens: 2 },
		total_cost_usd: 0,
	} as unknown as SDKMessage;
}

for (const mode of ["auto-approve", "full-access"] as const) {
	test(`Claude maps ${mode} without overriding the native reviewer`, async () => {
		const controls = { interrupted: 0, closed: 0 };
		const events: RuntimeEvent[] = [];
		let connection!: Awaited<ReturnType<ClaudeAdapter["open"]>>;
		const invoke = mockQuery(async function* (options) {
			assert.equal(options.permissionMode, mode === "auto-approve" ? "auto" : "bypassPermissions");
			assert.equal(options.allowDangerouslySkipPermissions, mode === "full-access" ? true : undefined);
			assert.equal(options.sandbox?.enabled, mode === "full-access" ? false : undefined);
			const signal = new AbortController().signal;
			const pre = await options.hooks!.PreToolUse![0].hooks[0](
				{
					hook_event_name: "PreToolUse",
					session_id: "native",
					transcript_path: "/native",
					cwd: "/project",
					tool_name: "Bash",
					tool_input: { command: "pwd" },
					tool_use_id: "tool",
				},
				"tool",
				{ signal },
			);
			assert.deepEqual(pre, {});
			assert.equal(
				events.some((event) => event.type === "approval"),
				false,
			);
			// Native auto mode calls this only when its classifier cannot decide. Relay must ask rather than bypass it.
			const answer = await options.canUseTool!(
				"Bash",
				{ command: "pwd" },
				{ signal, toolUseID: "tool", requestId: "request" },
			);
			assert.ok(answer);
			assert.equal(answer.behavior, mode === "full-access" ? "allow" : "deny");
			yield result();
		}, controls);
		const request = input("claude");
		request.permissionMode = mode;
		connection = await new ClaudeAdapter(invoke).open(request);
		await connection.submit({ id: "operation", text: "run", permissionMode: mode }, async (event) => {
			events.push(event);
			if (event.type === "approval") await connection.respond(event.id, false);
		});
		await connection.release();
	});
}

for (const liveDenial of [false, true]) {
	test(`Claude automatic denials settle attempted tools once (live notification: ${liveDenial})`, async () => {
		const controls = { interrupted: 0, closed: 0 };
		const events: RuntimeEvent[] = [];
		const invoke = mockQuery(async function* (options) {
			await options.hooks!.PreToolUse![0].hooks[0](
				{
					hook_event_name: "PreToolUse",
					session_id: "native",
					transcript_path: "/native",
					cwd: "/project",
					tool_name: "Bash",
					tool_input: { command: "blocked" },
					tool_use_id: "blocked",
				},
				"blocked",
				{ signal: new AbortController().signal },
			);
			if (liveDenial)
				yield {
					type: "system",
					subtype: "permission_denied",
					tool_name: "Bash",
					tool_use_id: "blocked",
					message: "Denied by classifier",
					uuid: randomUUID(),
					session_id: "native",
				};
			const completed = result();
			assert.equal(completed.type, "result");
			yield {
				...completed,
				permission_denials: [{ tool_name: "Bash", tool_use_id: "blocked", tool_input: { command: "blocked" } }],
			};
		}, controls);
		const request = input("claude");
		request.permissionMode = "auto-approve";
		const connection = await new ClaudeAdapter(invoke).open(request);
		await connection.submit({ id: "operation", text: "run", permissionMode: "auto-approve" }, async (event) => {
			events.push(event);
		});
		assert.equal(events.filter((event) => event.type === "tool_start").length, 1);
		assert.equal(events.filter((event) => event.type === "tool_end").length, 1);
		assert.ok(events.some((event) => event.type === "tool_end" && event.id === "blocked" && event.failed));
		await connection.release();
	});
}

test("Claude every-call hook enforces Relay policy even when native permissions would auto-approve", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-claude-"));
	try {
		const image = join(root, "fixture.png");
		await writeFile(image, Buffer.from("image-bytes"));
		const controls = { interrupted: 0, closed: 0 };
		let connection!: Awaited<ReturnType<ClaudeAdapter["open"]>>;
		const invoke = mockQuery(async function* (options, prompt) {
			assert.equal(options.permissionMode, "default");
			assert.equal(options.resume, "native-existing");
			assert.equal(options.env?.CLAUDE_CONFIG_DIR, "/profile");
			assert.equal(options.env?.ANTHROPIC_API_KEY, undefined);
			const message = await prompt[Symbol.asyncIterator]().next();
			assert.equal(message.value.type, "user");
			assert.ok(JSON.stringify(message.value.message.content).includes('"type":"image"'));
			assert.ok(JSON.stringify(message.value.message.content).includes(Buffer.from("image-bytes").toString("base64")));
			const base = {
				hook_event_name: "PreToolUse" as const,
				session_id: "native",
				transcript_path: "/native",
				cwd: root,
				tool_name: "Bash",
				tool_input: { command: "write" },
				tool_use_id: "write",
			};
			const denied = await options.hooks!.PreToolUse![0].hooks[0](base, "write", {
				signal: new AbortController().signal,
			});
			assert.equal(
				(denied as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision,
				"deny",
			);
			yield result();
		}, controls);
		const request = input("claude", root);
		request.record.nativeId = "native-existing";
		connection = await new ClaudeAdapter(invoke).open(request);
		await connection.submit(
			{
				id: "operation",
				text: "run",
				permissionMode: "ask",
				attachments: [
					{
						path: image,
						reference: {
							id: "image",
							uri: "file:///fixture.png",
							description: "Fixture",
							bytes: 11,
							mediaType: "image/png",
						},
					},
				],
			},
			async (event) => {
				if (event.type === "approval") await connection.respond(event.id, false);
			},
		);
		assert.equal(await connection.release(), "settled");
		assert.equal(controls.closed, 1);
	} finally {
		await rm(root, { recursive: true });
	}
});

test("Claude read-only sessions exclude write tools and private text blocks from events", async () => {
	const controls = { interrupted: 0, closed: 0 };
	const invoke = mockQuery(async function* (options) {
		assert.deepEqual(options.settingSources, []);
		assert.ok(options.disallowedTools?.includes("Write"));
		yield {
			type: "assistant",
			session_id: "native-claude",
			parent_tool_use_id: null,
			uuid: "fixture",
			message: {
				id: "answer",
				content: [
					{ type: "thinking", thinking: "secret" },
					{ type: "text", text: "Public" },
				],
			},
		} as unknown as SDKMessage;
		yield result();
	}, controls);
	const request = input("claude");
	request.permissionMode = "read-only";
	const connection = await new ClaudeAdapter(invoke).open(request);
	const events: RuntimeEvent[] = [];
	await connection.submit({ id: "operation", text: "read", permissionMode: "read-only" }, async (event) => {
		events.push(event);
	});
	assert.equal(JSON.stringify(events).includes("secret"), false);
	assert.ok(events.some((event) => event.type === "text" && event.text === "Public"));
	assert.equal(await connection.cancel(), "requested");
	assert.equal(controls.interrupted, 1);
	await connection.release();
});
