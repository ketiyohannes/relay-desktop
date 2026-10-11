import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DesktopEngineBridge } from "../../src/core/desktop/service-connection.ts";
import type { RuntimeAdapter } from "../../src/core/runtimes/types.ts";
import { RelayApplication } from "../../src/core/service/application.ts";
import { RelayClient } from "../../src/core/service/client.ts";
import { RelayServer } from "../../src/core/service/server.ts";
import { SessionLedger } from "../../src/core/sessions/ledger.ts";
import type { RelaySession } from "../../src/core/sessions/types.ts";

const execute = promisify(execFile);

test(
	"R02: oversized broadcast, cumulative retrieval, desktop continuation, reconnect, and CLI export preserve all events",
	{ timeout: 30000 },
	async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "relay-large-"));
		const directory = join(root, "app");
		const adapter: RuntimeAdapter = {
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
				nativeId: "offline",
				respond: async () => "expired",
				cancel: async () => "requested",
				release: async () => "settled",
				submit: async (_input, emit) => {
					await emit({ type: "text", id: "reply", text: "continued", complete: true });
					await emit({ type: "done", status: "completed" });
				},
			}),
		};
		const app = new RelayApplication(directory, [adapter]);
		const server = new RelayServer(app, directory);
		let client: RelayClient | undefined;
		try {
			await server.start();
			client = await RelayClient.connect(directory, false);
			const observed: number[] = [];
			client.subscribe((event) => observed.push(event.sequence));
			await client.request({
				type: "create",
				sessionId: "large",
				workspace: root,
				selection: { backend: "codex", model: "", profile: "" },
			});
			const large = "😀".repeat((17 * 1024 * 1024) / 4);
			await app.append("large", {
				type: "runtime",
				turnId: "old",
				nativeRecordId: "native",
				event: { type: "tool_end", id: "tool", name: "offline", output: large, failed: false },
			});
			await app.append("large", { type: "recovery", description: "small event after large output" });
			const full = (await client.request({ type: "get", sessionId: "large" })) as RelaySession;
			assert.deepEqual(observed, [1, 2, 3]);
			assert.equal(
				full.events[1].data.type === "runtime" &&
					full.events[1].data.event.type === "tool_end" &&
					full.events[1].data.event.output,
				large,
			);
			for (let index = 0; index < 18; index++)
				await app.append("large", {
					type: "runtime",
					turnId: "old",
					nativeRecordId: "native",
					event: { type: "text", id: `text-${index}`, text: "x".repeat(1024 * 1024), complete: true },
				});
			const created = (await client.request({
				type: "create",
				sessionId: "large",
				workspace: root,
				selection: { backend: "codex", model: "", profile: "" },
			})) as RelaySession;
			assert.equal(created.events.length, 21);
			const connection = client;
			const bridge = new DesktopEngineBridge(root, async () => connection);
			const session = {
				id: "large",
				name: "test",
				project: root,
				updated: 0,
				accountId: "account",
				autoSwitch: false,
				actions: [],
			};
			let response = "";
			await bridge.run(
				session,
				{ id: "account", name: "test", engine: "pi", provider: "openai-codex", model: "", configDir: "" },
				"continue",
				new AbortController(),
				{
					checkpoint: async () => {},
					permission: async () => false,
					session: async () => {},
					tool: async () => {},
					text: async (_id, text) => {
						response = text;
					},
				},
			);
			assert.equal(response, "continued");
			client.close();
			client = await RelayClient.connect(directory, false);
			const replayed = (await client.request({ type: "get", sessionId: "large" })) as RelaySession;
			assert.equal(replayed.turns.at(-1)?.status, "completed");
			const output = join(root, "export.json");
			await execute(
				process.execPath,
				[
					fileURLToPath(new URL("../../src/core/cli.ts", import.meta.url)),
					"export",
					"--session",
					"large",
					"--output",
					output,
				],
				{ env: { ...process.env, RELAY_APP_DIR: directory } },
			);
			const exported = JSON.parse(await readFile(output, "utf8")) as RelaySession;
			assert.deepEqual(
				exported.events.map((event) => event.sequence),
				replayed.events.map((event) => event.sequence),
			);
			const loaded = new SessionLedger(join(directory, "ledger"));
			await loaded.load();
			assert.deepEqual(
				JSON.parse(JSON.stringify(loaded.metadata().sort((a, b) => a.id.localeCompare(b.id)))),
				JSON.parse(JSON.stringify(app.ledger.metadata().sort((a, b) => a.id.localeCompare(b.id)))),
			);
		} finally {
			client?.close();
			await server.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);

test(
	"R08: real service delta bursts retain durable events and workspace checks exclude unrelated histories",
	{ timeout: 30000 },
	async (t) => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "relay-ledger-cost-"));
		const app = new RelayApplication(join(root, "app"), []);
		const loop = monitorEventLoopDelay({ resolution: 10 });
		loop.enable();
		const started = performance.now();
		try {
			await app.initialize();
			for (let session = 0; session < 20; session++) {
				await app.create(root, { backend: "codex", profile: "", model: "" }, "history", `session-${session}`);
				for (let event = 0; event < 50; event++)
					await app.append(`session-${session}`, {
						type: "runtime",
						turnId: "old",
						nativeRecordId: "native",
						event: { type: "text", id: "message", text: "x".repeat(1024), complete: false },
					});
			}
			const snapshot = t.mock.method(app.ledger, "list", () => {
				throw new Error("Full list must not be used by edit checks");
			});
			await app.create(root, { backend: "codex", profile: "", model: "" }, "edit", "edit");
			// No cross-session full snapshot is needed even when a disk read fails before effects.
			await assert.rejects(app.edit("edit", "operation", "missing", "", "content"), /ENOENT/);
			assert.equal(snapshot.mock.callCount(), 0);
			const before = performance.now();
			for (let check = 0; check < 1000; check++) app.ledger.workspaceBlocked("/unrelated");
			const summaryMs = performance.now() - before;
			const loaded = new SessionLedger(join(root, "app", "ledger"));
			await loaded.load();
			assert.deepEqual(
				JSON.parse(JSON.stringify(loaded.metadata().sort((a, b) => a.id.localeCompare(b.id)))),
				JSON.parse(JSON.stringify(app.ledger.metadata().sort((a, b) => a.id.localeCompare(b.id)))),
			);
			assert.equal(loaded.get("session-0").events.length, 51);
			t.diagnostic(
				`1,000 real synced content appends: elapsed ${(performance.now() - started).toFixed(1)} ms; unrelated ownership checks ${summaryMs.toFixed(1)} ms; max event-loop delay ${(loop.max / 1e6).toFixed(1)} ms; heap ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MiB. Each append still syncs before acknowledgment.`,
			);
		} finally {
			loop.disable();
			await rm(root, { recursive: true, force: true });
		}
	},
);
