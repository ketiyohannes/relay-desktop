import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "pi-sdk";
import type { RuntimeAdapter } from "../src/contracts.ts";
import { PiAdapter } from "../src/runtimes/pi/adapter.ts";
import { RelayApplication } from "../src/service/application.ts";
import { RelayClient } from "../src/service/client.ts";
import { RelayServer } from "../src/service/server.ts";
import { terminalHost } from "../src/terminal/host.ts";

test(
	"published pi terminal hooks mirror pi turns and route native input in the same terminal offline",
	{ timeout: 15000 },
	async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "relay-terminal-"));
		const directory = join(root, "app");
		let nativeCalls = 0;
		const codex: RuntimeAdapter = {
			backend: "codex",
			discover: async () => ({
				resume: true,
				cancel: "interrupt",
				approvals: "native",
				compaction: "native",
				tools: [],
				mcp: false,
				limitations: [],
			}),
			open: async () => ({
				nativeId: "codex-thread",
				submit: async (input, emit) => {
					nativeCalls++;
					assert.ok(input.handoff?.conversation.some((message) => message.text === "Done"));
					await emit({ type: "accepted" });
					await emit({ type: "text", id: "codex-reply", text: "Codex continued", complete: true });
					await emit({ type: "done", status: "completed" });
				},
				respond: async () => "expired",
				cancel: async () => "requested",
				release: async () => "settled",
			}),
		};
		const app = new RelayApplication(directory, [new PiAdapter(), codex]);
		const server = new RelayServer(app, directory);
		let client: RelayClient | undefined;
		try {
			await server.start();
			client = await RelayClient.connect(directory, false);
			const profile = join(root, "profile");
			await mkdir(profile);
			const faux = fauxProvider({ provider: "relay-faux", tokensPerSecond: 100000 });
			const models = await ModelRuntime.create({
				authPath: join(profile, "auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			models.registerNativeProvider(faux.provider);
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "result", content: "saved" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxThinking("private reasoning sentinel"), fauxText("Done")]),
			]);
			await client.request({
				type: "create",
				sessionId: "terminal",
				workspace: root,
				selection: { backend: "pi", model: faux.getModel().id, profile, options: { provider: "relay-faux" } },
			});
			const settings = SettingsManager.inMemory();
			const loader = new DefaultResourceLoader({
				cwd: root,
				agentDir: profile,
				settingsManager: settings,
				disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
				extensionFactories: [
					{ name: "relay-host", factory: terminalHost(client, "terminal", profile, "auto-edit") },
				],
			});
			await loader.reload();
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: profile,
				modelRuntime: models,
				model: faux.getModel(),
				resourceLoader: loader,
				settingsManager: settings,
				sessionManager: SessionManager.create(root, join(root, "native")),
			});
			await session.bindExtensions({
				mode: "tui",
				abortHandler: () => {
					void session.abort();
				},
			});
			await session.prompt("Write result");
			assert.equal(await readFile(join(root, "result"), "utf8"), "saved");
			const global = app.ledger.get("terminal");
			assert.equal(global.turns[0].status, "completed");
			assert.equal(global.natives[0].nativeId, session.sessionManager.getSessionId());
			assert.ok(
				global.events.some((event) => event.data.type === "runtime" && event.data.event.type === "tool_end"),
			);
			assert.equal(JSON.stringify(global.events).includes("private reasoning sentinel"), false);
			await client.request({
				type: "select",
				sessionId: "terminal",
				selection: { backend: "codex", model: "", profile: "" },
			});
			let finished!: () => void;
			const completion = new Promise<void>((resolve) => {
				finished = resolve;
			});
			let shown!: () => void;
			const displayed = new Promise<void>((resolve) => {
				shown = resolve;
			});
			const stopDisplay = session.subscribe((event) => {
				if (
					event.type === "message_end" &&
					event.message.role === "custom" &&
					event.message.customType === "relay-native-display"
				)
					shown();
			});
			const unsubscribe = app.subscribe((event) => {
				if (event.data.type === "turn" && event.data.status === "completed") finished();
			});
			try {
				await session.prompt("Continue in Codex");
				await completion;
				await displayed;
				assert.equal(nativeCalls, 1);
				assert.ok(
					session.sessionManager
						.getBranch()
						.some(
							(entry) =>
								entry.type === "custom_message" &&
								entry.customType === "relay-native-display" &&
								typeof entry.content === "string" &&
								entry.content.includes("Codex continued"),
						),
				);
				await client.request({
					type: "select",
					sessionId: "terminal",
					selection: { backend: "pi", model: faux.getModel().id, profile, options: { provider: "relay-faux" } },
				});
				faux.setResponses([fauxAssistantMessage("Pi continued")]);
				await session.prompt("Continue in pi");
				assert.equal(app.ledger.get("terminal").turns.at(-1)?.status, "completed");
				assert.equal(nativeCalls, 1);
			} finally {
				unsubscribe();
				stopDisplay();
			}
			await session.dispose();
		} finally {
			client?.close();
			await server.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);
