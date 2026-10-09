import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopRuntime } from "../../src/core/desktop/runtime.ts";
import { DesktopStore } from "../../src/core/desktop/store.ts";
import type { DesktopState, DesktopUpdate } from "../../src/core/desktop/types.ts";

test("large history migrates losslessly; a thousand deltas use bounded IPC and saves and survive restart", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-performance-"));
	try {
		const seed: DesktopState = {
			projects: [root],
			accounts: [{ id: "fake", name: "Offline", engine: "pi", provider: "offline", model: "fake", configDir: root }],
			sessions: Array.from({ length: 21 }, (_, index) => ({
				id: `session-${index}`,
				project: root,
				name: `Session ${index}`,
				accountId: "fake",
				autoSwitch: true,
				updated: 1,
				actions:
					index === 0 ? [] : [{ id: `large-${index}`, kind: "assistant", text: "history".repeat(150000), time: 1 }],
			})),
		};
		const raw = JSON.stringify(seed);
		assert.ok(Buffer.byteLength(raw) > 20 * 1024 * 1024);
		await writeFile(join(root, "state.json"), raw);
		const states: DesktopState[] = [];
		const updates: DesktopUpdate[] = [];
		let finish!: () => void;
		const finished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let saves = 0;
		const runtime = new DesktopRuntime(
			root,
			{
				state: (state) => {
					states.push(state);
					if (!state.busySession && state.sessions[0]?.actions.some((action) => action.text === "x".repeat(1000)))
						finish();
				},
				update: (update) => updates.push(update),
				permission: async () => false,
			},
			async (_session, _account, _prompt, _abort, callbacks) => {
				for (let index = 0; index < 1000; index++) {
					await callbacks.text("reply", "x", false);
					if (index % 200 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 65));
				}
				await callbacks.text("reply", "x".repeat(1000), true);
			},
			async (account) => ({ configDir: account.configDir, connected: true, models: [] }),
			[],
		);
		await runtime.initialize();
		assert.ok(Buffer.byteLength(JSON.stringify(states[0])) < 10000);
		await runtime.command({ type: "session_load", sessionId: "session-0" });
		await runtime.store.save();
		assert.equal(await readFile(join(root, "state.legacy.json"), "utf8"), raw);
		const files = await readdir(join(root, "conversations"));
		const before = new Map(
			await Promise.all(
				files.map(async (file) => [file, (await stat(join(root, "conversations", file))).mtimeMs] as const),
			),
		);
		const save = runtime.store.save.bind(runtime.store);
		runtime.store.save = (ids) => {
			saves++;
			return save(ids);
		};
		await runtime.command({ type: "prompt", sessionId: "session-0", text: "Stream offline" });
		await finished;
		assert.ok(updates.length > 0 && updates.length < 20, `${updates.length} streaming updates`);
		assert.ok(Buffer.byteLength(JSON.stringify(updates)) < 50000);
		assert.ok(saves <= 3, `${saves} projection saves`);
		assert.ok(states.every((state) => Buffer.byteLength(JSON.stringify(state)) < 20000));
		let changed = 0;
		for (const file of files)
			if ((await stat(join(root, "conversations", file))).mtimeMs !== before.get(file)) changed++;
		assert.equal(changed, 1);
		const restarted = new DesktopStore(root);
		await restarted.load();
		assert.equal(restarted.session("session-0").actions.at(-1)?.text, "x".repeat(1000));
		assert.equal(restarted.session("session-20").actions[0].text, seed.sessions[20].actions[0].text);
		const index = await readFile(join(root, "state.json"), "utf8");
		runtime.store.session("session-0").relayLedgerSequence = 42;
		await runtime.store.save(["session-0"]);
		// Simulate a crash after the history commits but before the index is replaced.
		await writeFile(join(root, "state.json"), index);
		const recovered = new DesktopStore(root);
		await recovered.load();
		assert.equal(recovered.session("session-0").relayLedgerSequence, 42);
		assert.equal(recovered.session("session-0").actions.at(-1)?.text, "x".repeat(1000));
		await rm(join(root, "conversations", files[0]));
		await assert.rejects(new DesktopStore(root).load(), /ENOENT/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
