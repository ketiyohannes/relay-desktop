import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type TerminalInputHandler } from "pi-sdk";
import type { RuntimeAdapter, RuntimeSelection } from "../../src/core/contracts.ts";
import { RelayApplication } from "../../src/core/service/application.ts";
import { RelayServer } from "../../src/core/service/server.ts";
import { NativeTerminal } from "../../src/core/terminal/native.ts";

test("one terminal routes Codex and Claude, preserves workspace evidence, and cancels with configured keys", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-native-terminal-"));
	const selection = (backend: "codex" | "claude"): RuntimeSelection => ({ backend, model: backend, profile: "" });
	const capabilities = {
		resume: true,
		cancel: "interrupt" as const,
		approvals: "native" as const,
		compaction: "native" as const,
		tools: [],
		mcp: false,
		limitations: [],
	};
	let stop!: () => void;
	let ready!: () => void;
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	let hold = false;
	const adapters: RuntimeAdapter[] = ["codex", "claude"].map((backend) => ({
		backend: backend as "codex" | "claude",
		discover: async () => capabilities,
		open: async () => ({
			nativeId: backend,
			submit: async (input, emit) => {
				await emit({ type: "accepted" });
				if (hold) {
					await new Promise<void>((resolve) => {
						stop = resolve;
						ready();
					});
					await emit({ type: "done", status: "cancelled" });
					return;
				}
				if (backend === "codex") await writeFile(join(root, "changed"), "saved");
				else {
					assert.equal(await readFile(join(root, "changed"), "utf8"), "saved");
					assert.ok(input.handoff?.conversation.some((message) => message.text === "Codex saved"));
				}
				await emit({
					type: "text",
					id: "reply",
					text: backend === "codex" ? "Codex saved" : "Claude reviewed",
					complete: true,
				});
				await emit({ type: "done", status: "completed" });
			},
			respond: async () => "expired",
			cancel: async () => {
				stop?.();
				return "requested";
			},
			release: async () => "settled",
		}),
	}));
	const app = new RelayApplication(join(root, "app"), adapters);
	await app.initialize();
	const server = new RelayServer(app, join(root, "app"));
	await app.create(root, selection("codex"), "Terminal", "session");
	await writeFile(join(root, "keybindings.json"), JSON.stringify({ "app.interrupt": "ctrl+x" }));
	const displayed: string[] = [];
	const status: string[] = [];
	let onInput: TerminalInputHandler | undefined;
	let pauseSnapshot = false;
	let releaseSnapshot!: () => void;
	let snapshotStarted!: () => void;
	const snapshotReady = new Promise<void>((resolve) => {
		releaseSnapshot = resolve;
	});
	const snapshotBeginning = new Promise<void>((resolve) => {
		snapshotStarted = resolve;
	});
	const context = {
		mode: "tui" as const,
		hasUI: true,
		sessionManager: SessionManager.inMemory(root),
		ui: {
			confirm: async () => false,
			notify: () => {},
			setWidget: () => {},
			setStatus: (_id: string, text: string | undefined) => {
				if (text) status.push(text);
			},
			onTerminalInput: (handler: TerminalInputHandler) => {
				onInput = handler;
				return () => {
					onInput = undefined;
				};
			},
		},
	};
	const terminal = new NativeTerminal(
		{
			request: async (command) => {
				if (command.type === "get" && pauseSnapshot) {
					pauseSnapshot = false;
					snapshotStarted();
					await snapshotReady;
				}
				return server.command(command);
			},
			subscribe: (listener) => app.subscribe(listener),
		},
		{
			sendMessage: (message) => {
				if (typeof message.content === "string") displayed.push(message.content);
				context.sessionManager.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display ?? true,
					message.details,
				);
			},
		},
		() => "session",
		"ask",
	);
	try {
		await terminal.initialize(context, root);
		pauseSnapshot = true;
		const preparing = terminal.input(
			{ type: "input", text: "Cancel before submission", source: "interactive" },
			context,
		);
		await snapshotBeginning;
		assert.equal(terminal.busy, true);
		assert.equal(await terminal.input({ type: "input", text: "Duplicate", source: "interactive" }, context), true);
		await terminal.cancel();
		releaseSnapshot();
		assert.equal(await preparing, true);
		assert.equal(app.ledger.get("session").turns.length, 0, "cancelled preparation cannot start native work");
		assert.equal(await terminal.input({ type: "input", text: "Make change", source: "interactive" }, context), true);
		await terminal.waitForIdle();
		await terminal.select(selection("claude"), context);
		await terminal.input({ type: "input", text: "Review change", source: "interactive" }, context);
		await terminal.waitForIdle();
		assert.match(displayed.join("\n"), /Codex saved/);
		assert.match(displayed.join("\n"), /Claude reviewed/);
		assert.ok(status.some((text) => text.includes("Relay claude")));
		const restored = new NativeTerminal(
			{ request: (command) => server.command(command), subscribe: (listener) => app.subscribe(listener) },
			{
				sendMessage: (message) => {
					if (typeof message.content === "string") displayed.push(message.content);
				},
			},
			() => "session",
			"ask",
		);
		try {
			const before = displayed.length;
			await restored.initialize(context, root);
			assert.equal(displayed.length, before, "native journal already displays these messages");
			await restored.initialize({ ...context, sessionManager: SessionManager.inMemory(root) }, root);
			assert.match(displayed.at(-1)!, /Codex saved/);
			assert.match(displayed.at(-1)!, /Claude reviewed/);
		} finally {
			await restored.close();
		}
		await terminal.initialize(context, root);
		hold = true;
		await terminal.input({ type: "input", text: "Wait", source: "interactive" }, context);
		await started;
		await assert.rejects(terminal.select(selection("codex"), context), /Cancel and wait/);
		assert.equal(onInput?.("\u001b"), undefined);
		assert.deepEqual(onInput?.("\u0018"), { consume: true });
		await terminal.waitForIdle();
		assert.equal(app.ledger.get("session").turns.at(-1)?.status, "cancelled");
		await terminal.select({ backend: "pi", model: "kimi", profile: "", options: { provider: "moonshot" } }, context);
		assert.equal(
			await terminal.input({ type: "input", text: "Continue with pi", source: "interactive" }, context),
			false,
		);
	} finally {
		await terminal.close();
		await app.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
