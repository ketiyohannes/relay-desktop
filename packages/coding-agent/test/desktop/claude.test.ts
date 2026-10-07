import { InMemorySessionStore, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { AccountExhaustedError, type ClaudeQuery, type EngineCallbacks, runClaude } from "../../src/desktop/engines.ts";
import type { DesktopAccount, DesktopSession } from "../../src/desktop/types.ts";

const account: DesktopAccount = {
	id: "claude-2",
	name: "Second Claude",
	engine: "claude",
	configDir: "/profiles/second",
	provider: "",
	model: "sonnet",
};
function session(): DesktopSession {
	return {
		id: "relay-session",
		project: "/project",
		name: "shared",
		accountId: account.id,
		updated: 0,
		autoSwitch: true,
		claudeSessionId: "native-session",
		lastEngine: "pi",
		actions: [
			{ id: "done", time: 1, kind: "tool", text: "write completed", input: '{"path":"done.ts"}', status: "done" },
		],
	};
}
function callbacks(events: string[]): EngineCallbacks {
	return {
		text: async (_id, text, complete) => {
			events.push(`${complete ? "complete" : "delta"}:${text}`);
		},
		tool: async (_id, name, _input, result) => {
			events.push(`${result === undefined ? "start" : "end"}:${name}`);
		},
		checkpoint: async (label) => {
			events.push(label);
		},
		session: async (id) => {
			events.push(`session:${id}`);
		},
		permission: async () => true,
	};
}
function result(isError: boolean, text: string): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: isError,
		result: text,
		session_id: "native-session",
		uuid: randomUUID(),
		// Synthetic wire fixture omits unused SDK billing telemetry.
	} as unknown as SDKMessage;
}

describe("Claude Agent SDK bridge", () => {
	it("isolates snapshot reviews and denies write hooks even if the profile has permissive settings", async () => {
		const handler = callbacks([]);
		handler.readOnly = true;
		handler.permission = async (tool) => tool === "Read";
		const invoke: ClaudeQuery = async function* ({ options }) {
			expect(options.resume).toBeUndefined();
			expect(options.settingSources).toEqual([]);
			expect(options.tools).toEqual(["Read", "Grep", "Glob"]);
			expect(options.disallowedTools).toContain("Bash");
			const denied = await options.hooks!.PreToolUse![0].hooks[0](
				{
					hook_event_name: "PreToolUse",
					session_id: "review",
					transcript_path: "/review",
					cwd: "/snapshot",
					tool_name: "Write",
					tool_input: { file_path: "/snapshot/base.ts" },
					tool_use_id: "write",
				},
				"write",
				{ signal: new AbortController().signal },
			);
			expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
			yield result(false, "Reviewed");
		};
		await runClaude(session(), account, "Review", new AbortController(), new InMemorySessionStore(), handler, invoke);
	});
	it("resumes across profiles, bridges shared history, awaits tool checkpoints, and streams text", async () => {
		const events: string[] = [];
		let options: Options | undefined;
		const invoke: ClaudeQuery = async function* (request) {
			options = request.options;
			expect(request.prompt).toContain("done.ts");
			const base = {
				session_id: "native-session",
				transcript_path: "/transcript",
				cwd: "/project",
				tool_name: "Write",
				tool_input: { file_path: "/project/new.ts" },
				tool_use_id: "tool-1",
			};
			const signal = { signal: new AbortController().signal };
			await request.options.hooks!.PreToolUse![0].hooks[0](
				{ ...base, hook_event_name: "PreToolUse" },
				"tool-1",
				signal,
			);
			await request.options.hooks!.PostToolUse![0].hooks[0](
				{ ...base, hook_event_name: "PostToolUse", tool_response: "written" },
				"tool-1",
				signal,
			);
			yield {
				type: "stream_event",
				uuid: randomUUID(),
				session_id: "native-session",
				parent_tool_use_id: null,
				event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
			};
			yield {
				type: "assistant",
				uuid: randomUUID(),
				session_id: "native-session",
				parent_tool_use_id: null,
				message: { content: [{ type: "text", text: "Hello" }] },
			} as unknown as SDKMessage;
			yield result(false, "Hello");
		};
		await runClaude(
			session(),
			account,
			"continue",
			new AbortController(),
			new InMemorySessionStore(),
			callbacks(events),
			invoke,
		);
		expect(options?.resume).toBe("native-session");
		expect(options?.env?.CLAUDE_CONFIG_DIR).toBe("/profiles/second");
		expect(options?.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
		expect(options?.env?.ANTHROPIC_API_KEY).toBeUndefined();
		expect(events.slice(0, 4)).toEqual(["Before tool", "start:Write", "end:Write", "After Write"]);
		expect(events).toContain("delta:Hello");
		expect(events).toContain("complete:Hello");
	});

	it("classifies a structured subscription rejection but leaves generic 429s unchanged", async () => {
		const invoke: ClaudeQuery = async function* () {
			yield {
				type: "rate_limit_event",
				uuid: randomUUID(),
				session_id: "native-session",
				rate_limit_info: { status: "rejected", rateLimitType: "seven_day" },
			};
			yield result(true, "Subscription usage exhausted");
		};
		await expect(
			runClaude(
				session(),
				account,
				"continue",
				new AbortController(),
				new InMemorySessionStore(),
				callbacks([]),
				invoke,
			),
		).rejects.toBeInstanceOf(AccountExhaustedError);
		const transient: ClaudeQuery = async function* () {
			yield result(true, "429 too many requests");
		};
		await expect(
			runClaude(
				session(),
				account,
				"continue",
				new AbortController(),
				new InMemorySessionStore(),
				callbacks([]),
				transient,
			),
		).rejects.not.toBeInstanceOf(AccountExhaustedError);
	});

	it("stops on transcript mirror errors rather than continuing with missing history", async () => {
		const invoke: ClaudeQuery = async function* () {
			yield {
				type: "system",
				subtype: "mirror_error",
				uuid: randomUUID(),
				session_id: "native-session",
				error: "write failed",
				key: { projectKey: "/project", sessionId: "native-session" },
			};
		};
		await expect(
			runClaude(
				session(),
				account,
				"continue",
				new AbortController(),
				new InMemorySessionStore(),
				callbacks([]),
				invoke,
			),
		).rejects.toThrow("transcript mirror failed");
	});

	it.each(["stream throws", "stream ends"])("recovers a structured rejection when %s", async (ending) => {
		const invoke: ClaudeQuery = async function* () {
			yield {
				type: "rate_limit_event",
				uuid: randomUUID(),
				session_id: "native-session",
				rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
			};
			if (ending === "stream throws") throw new Error("SDK process exited");
		};
		await expect(
			runClaude(
				session(),
				account,
				"continue",
				new AbortController(),
				new InMemorySessionStore(),
				callbacks([]),
				invoke,
			),
		).rejects.toBeInstanceOf(AccountExhaustedError);
	});
	it.each(["allowed", "allowed_warning"] as const)("does not rotate when overage is %s", async (overageStatus) => {
		const invoke: ClaudeQuery = async function* () {
			yield {
				type: "rate_limit_event",
				uuid: randomUUID(),
				session_id: "native-session",
				rate_limit_info: { status: "rejected", overageStatus, rateLimitType: "five_hour" },
			};
			yield result(true, "429 too many requests");
		};
		await expect(
			runClaude(
				session(),
				account,
				"continue",
				new AbortController(),
				new InMemorySessionStore(),
				callbacks([]),
				invoke,
			),
		).rejects.not.toBeInstanceOf(AccountExhaustedError);
	});
	it("does not turn persistence errors after rejection into quota recovery", async () => {
		const handler = callbacks([]);
		handler.text = async () => {
			throw new Error("Persistence failed");
		};
		const invoke: ClaudeQuery = async function* () {
			yield {
				type: "rate_limit_event",
				uuid: randomUUID(),
				session_id: "native-session",
				rate_limit_info: { status: "rejected", rateLimitType: "seven_day" },
			};
			yield {
				type: "assistant",
				uuid: randomUUID(),
				session_id: "native-session",
				parent_tool_use_id: null,
				message: { content: [{ type: "text", text: "error" }] },
			} as unknown as SDKMessage;
		};
		await expect(
			runClaude(session(), account, "continue", new AbortController(), new InMemorySessionStore(), handler, invoke),
		).rejects.toThrow("Persistence failed");
	});
	it("stops on cancellation even after a structured quota rejection", async () => {
		const abort = new AbortController();
		const invoke: ClaudeQuery = async function* () {
			yield {
				type: "rate_limit_event",
				uuid: randomUUID(),
				session_id: "native-session",
				rate_limit_info: { status: "rejected", rateLimitType: "seven_day" },
			};
			abort.abort();
			throw new Error("SDK aborted");
		};
		await expect(
			runClaude(session(), account, "continue", abort, new InMemorySessionStore(), callbacks([]), invoke),
		).rejects.toThrow("Cancelled");
	});
});

import { randomUUID } from "node:crypto";
