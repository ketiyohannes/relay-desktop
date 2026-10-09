import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeAdapter } from "../../src/core/contracts.ts";
import { RelayApplication } from "../../src/core/service/application.ts";

for (const backend of ["codex", "claude"] as const) {
	test(`${backend} cancellation settles two native approval gates once before interrupting, then permits another session`, async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "relay-cancel-"));
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		let finish!: () => void;
		const interrupted = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const pending = new Set<string>();
		const responses: string[] = [];
		let cancellations = 0;
		let runs = 0;
		const adapter: RuntimeAdapter = {
			backend,
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
				nativeId: "offline-native",
				submit: async (_input, emit) => {
					if (runs++) {
						await emit({ type: "done", status: "completed" });
						return;
					}
					for (const id of ["one", "two"]) {
						pending.add(id);
						await emit({ type: "tool_start", id, name: "bash", input: { command: "offline" } });
						await emit({ type: "approval", id, tool: "bash", input: {} });
					}
					ready();
					await interrupted;
					for (const id of ["one", "two"])
						await emit({ type: "tool_end", id, name: "bash", output: "Denied; no effects", failed: true });
					await emit({ type: "done", status: "cancelled" });
				},
				respond: async (id, allowed) => {
					assert.equal(allowed, false);
					if (!pending.delete(id)) return "expired";
					responses.push(id);
					return "sent";
				},
				cancel: async () => {
					cancellations++;
					pending.clear();
					finish();
					return "requested";
				},
				release: async () => "settled",
			}),
		};
		const app = new RelayApplication(join(root, "app"), [adapter]);
		try {
			await app.initialize();
			const session = await app.create(root, { backend, profile: "", model: "offline" });
			const run = app.submit(session.id, "Wait for approvals", "ask", "cancel-turn");
			await started;
			await Promise.all([app.cancel(session.id), app.cancel(session.id)]);
			assert.equal(await run, "cancelled");
			assert.deepEqual(responses, ["one", "two"]);
			assert.equal(cancellations, 1);
			assert.ok(app.ledger.get(session.id).approvals.every((approval) => approval.status === "interrupted"));
			assert.deepEqual(app.recovery(root), []);
			const next = await app.create(root, { backend, profile: "", model: "offline" });
			assert.equal(await app.submit(next.id, "Continue"), "completed");
		} finally {
			finish();
			await app.shutdown();
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("recovery identifies a blocker in another session and retains missing tool outcomes until explicit reconciliation", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-recovery-"));
	try {
		const app = new RelayApplication(join(root, "app"), []);
		await app.initialize();
		await app.create(root, { backend: "codex", profile: "", model: "offline" }, "Blocking session", "blocked");
		await app.append("blocked", {
			type: "turn",
			turnId: "unknown-turn",
			nativeRecordId: "native",
			status: "unknown",
		});
		await app.append("blocked", {
			type: "runtime",
			turnId: "unknown-turn",
			nativeRecordId: "native",
			event: { type: "tool_start", id: "unfinished", name: "bash", input: { command: "inspect me" } },
		});
		const entries = app.recovery(root);
		assert.equal(entries[0].sessionId, "blocked");
		assert.equal(entries[0].tools[0].finished, false);
		assert.equal(entries[0].active, false);
		await assert.rejects(app.reconcile("blocked", "unknown-turn", ""), /verification/);
		assert.equal(app.ledger.get("blocked").turns[0].status, "unknown");
		await app.reconcile("blocked", "unknown-turn", "Verified native processes stopped; inspected working files");
		assert.deepEqual(app.recovery(root), []);
		assert.equal(
			app.ledger.get("blocked").events.some((event) => event.data.type === "runtime"),
			true,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
