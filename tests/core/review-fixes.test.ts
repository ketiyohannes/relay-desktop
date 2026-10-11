import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import fs, { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopRuntime } from "../../src/core/desktop/commands.ts";
import { DesktopRequests } from "../../src/core/desktop/requests.ts";
import { DesktopStore } from "../../src/core/desktop/store.ts";
import { PermissionGate } from "../../src/core/permissions/gate.ts";
import { RelayApplication } from "../../src/core/service/application.ts";
import { SessionLedger } from "../../src/core/sessions/ledger.ts";
import type { LedgerData } from "../../src/core/sessions/types.ts";
import { ProcessLock } from "../../src/core/storage/process-lock.ts";

const worker = fileURLToPath(new URL("./fixtures/review-writer.ts", import.meta.url));
function message(child: ChildProcess): Promise<{ type: string; message?: string }> {
	return new Promise((resolve, reject) => {
		child.once("message", (value) => resolve(value as { type: string; message?: string }));
		child.once("error", reject);
	});
}
async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGKILL");
	await exited;
}

test("R01: independent stale desktop writers cannot replace a newer index", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-writers-"));
	const first = fork(worker, ["store", root, "project-a"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const second = fork(worker, ["store", root, "project-b"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
	try {
		await Promise.all([message(first), message(second)]);
		const saved = message(first);
		first.send("save");
		assert.equal((await saved).type, "saved");
		const rejected = message(second);
		second.send("save");
		assert.match((await rejected).message ?? "", /changed in another writer/);
		const store = new DesktopStore(root);
		await store.load();
		assert.deepEqual(store.state.projects, ["project-a"]);
	} finally {
		await Promise.all([stop(first), stop(second)]);
		await rm(root, { recursive: true, force: true });
	}
});

test("R10: interrupted owner commit and interrupted recovery restart safely; competing live owners are refused", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-lock-crash-"));
	const path = join(root, "service.lock");
	const children: ChildProcess[] = [];
	try {
		const before = fork(worker, ["pause-claim", path], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
		children.push(before);
		assert.equal((await message(before)).type, "paused");
		await stop(before);
		const initial = await ProcessLock.acquire(path);
		await initial.release();
		const dead = fork(worker, ["lock", path], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
		children.push(dead);
		assert.equal((await message(dead)).type, "owned");
		await stop(dead);
		const recovering = fork(worker, ["pause-recovery", path], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
		children.push(recovering);
		assert.equal((await message(recovering)).type, "paused");
		await stop(recovering);
		const contenders = [0, 1].map(() =>
			fork(worker, ["lock", path], { stdio: ["ignore", "ignore", "inherit", "ipc"] }),
		);
		children.push(...contenders);
		const results = await Promise.all(contenders.map(message));
		assert.equal(results.filter((result) => result.type === "owned").length, 1);
		assert.equal(results.filter((result) => result.type === "error").length, 1);
		await assert.rejects(ProcessLock.acquire(path), /already running/);
	} finally {
		await Promise.all(children.map(stop));
		await rm(root, { recursive: true, force: true });
	}
});

test("R10: platform-specific directory rename errors still protect a live lock owner", async (t) => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-lock-rename-"));
	const path = join(root, "service.lock");
	const lock = await ProcessLock.acquire(path);
	try {
		const rename = fs.rename;
		t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
			if (args[1] === path) throw Object.assign(new Error("Existing directory"), { code: "EPERM" });
			return rename(...args);
		});
		syncBuiltinESMExports();
		await assert.rejects(ProcessLock.acquire(path), /already running/);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await lock.release();
		await rm(root, { recursive: true, force: true });
	}
});

test("R10: malformed legacy ownership gives repair guidance and preserves evidence", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-lock-diagnostic-"));
	const path = join(root, "service.lock");
	try {
		await mkdir(path);
		await writeFile(join(path, "evidence"), "keep");
		await assert.rejects(ProcessLock.acquire(path), /Stop all Relay.*move this lock directory aside/);
		assert.equal(await readFile(join(path, "evidence"), "utf8"), "keep");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("R03: failed editor lease release is recoverable without restart", async (t) => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-edit-cleanup-"));
	const app = new RelayApplication(join(root, "app"), []);
	try {
		await app.initialize();
		await app.create(root, { backend: "codex", profile: "", model: "" }, "edit", "session");
		await writeFile(join(root, "file"), "before");
		const release = t.mock.method(app.resources, "release", async () => {
			throw new Error("Injected release failure");
		});
		await assert.rejects(app.edit("session", "edit", "file", "before", "after"), /release failure/);
		release.mock.restore();
		assert.equal(await readFile(join(root, "file"), "utf8"), "after");
		assert.equal(app.recovery(root)[0].turnId, "edit:edit");
		await assert.rejects(app.edit("session", "next", "file", "after", "next"), /reconciliation/);
		await app.reconcile("session", "edit:edit", "Replacement inspected; no writer remains");
		assert.deepEqual(app.recovery(root), []);
		await app.edit("session", "next", "file", "after", "next");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const boundary of ["file-sync", "rename", "directory-sync", "journal-completion"] as const) {
	test(`R07: ${boundary} failure cannot acknowledge durable editor completion`, async (t) => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "relay-edit-durable-"));
		const app = new RelayApplication(join(root, "app"), []);
		try {
			await app.initialize();
			await app.create(root, { backend: "codex", profile: "", model: "" }, "edit", "session");
			await writeFile(join(root, "file"), "before");
			const open = fs.open;
			t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
				const handle = await open(...args);
				if (
					(boundary === "file-sync" && String(args[0]).includes(".relay-edit-")) ||
					(boundary === "directory-sync" && args[0] === root)
				)
					t.mock.method(handle, "sync", async () => {
						throw new Error(`Injected ${boundary}`);
					});
				return handle;
			});
			const rename = fs.rename;
			t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
				if (boundary === "rename" && String(args[0]).includes(".relay-edit-")) throw new Error("Injected rename");
				return rename(...args);
			});
			syncBuiltinESMExports();
			const append = app.append.bind(app);
			t.mock.method(app, "append", async (id: string, data: LedgerData) => {
				if (boundary === "journal-completion" && data.type === "manual_edit" && data.status === "completed")
					throw new Error("Injected journal-completion");
				return append(id, data);
			});
			await assert.rejects(app.edit("session", "edit", "file", "before", "after"), /Injected/);
			assert.equal(
				app.ledger
					.get("session")
					.events.some((event) => event.data.type === "manual_edit" && event.data.status === "completed"),
				false,
			);
			assert.equal(app.recovery(root)[0].turnId, "edit:edit");
			assert.equal(
				await readFile(join(root, "file"), "utf8"),
				boundary === "file-sync" || boundary === "rename" ? "before" : "after",
			);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("R04: initial save failure starts no engine; final failure exposes unsaved state and supports retry", async (t) => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-final-save-"));
	let runs = 0;
	let published: { busy?: string; error?: string } = {};
	let finished!: () => void;
	const failed = new Promise<void>((resolve) => {
		finished = resolve;
	});
	const runtime = new DesktopRuntime(
		root,
		{
			permission: async () => false,
			state: (state) => {
				published = { busy: state.busySession, error: state.persistenceError };
				if (state.persistenceError?.includes("Final save failed") && !state.busySession) finished();
			},
		},
		async (_session, _account, _text, _abort, callbacks) => {
			runs++;
			await callbacks.text("reply", "done", true);
		},
		undefined,
		[],
	);
	try {
		await runtime.initialize();
		runtime.store.state.accounts.push({
			id: "account",
			name: "test",
			engine: "claude",
			provider: "",
			configDir: "",
			model: "offline",
		});
		runtime.store.state.sessions.push({
			id: "session",
			project: root,
			name: "test",
			accountId: "account",
			autoSwitch: false,
			updated: 0,
			actions: [],
		});
		const save = runtime.store.save.bind(runtime.store);
		const initial = t.mock.method(runtime.store, "save", async () => {
			throw new Error("Initial save failed");
		});
		await assert.rejects(
			runtime.command({ type: "prompt", sessionId: "session", text: "work" }),
			/Initial save failed/,
		);
		assert.equal(runs, 0);
		assert.equal(published.busy, undefined);
		assert.match(published.error ?? "", /Initial save failed/);
		initial.mock.restore();
		let injected = false;
		t.mock.method(runtime.store, "save", async () => {
			if (!runtime.store.state.busySession && !injected) {
				injected = true;
				throw new Error("Final save failed");
			}
			return save();
		});
		await runtime.command({ type: "prompt", sessionId: "session", text: "work" });
		await failed;
		assert.equal(runtime.store.state.busySession, undefined);
		assert.match(runtime.store.state.persistenceError ?? "", /Final save failed/);
		await runtime.command({ type: "retry_save" });
		assert.equal(runtime.store.state.persistenceError, undefined);
		const loaded = new DesktopStore(root);
		await loaded.load();
		assert.equal(loaded.session("session").actions.at(-1)?.text, "done");
		assert.equal(loaded.state.persistenceError, undefined);
		await runtime.command({ type: "prompt", sessionId: "session", text: "again" });
		// Wait for the published final state rather than deleting data during asynchronous finalization.
		while (runtime.store.state.busySession) await new Promise<void>((resolve) => setTimeout(resolve, 5));
		await runtime.command({ type: "retry_save" });
		assert.equal(runs, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("R02: paged histories stop at their initial boundary when later events arrive", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-page-boundary-"));
	try {
		const ledger = new SessionLedger(root);
		await ledger.load();
		await ledger.append("session", {
			type: "created",
			workspace: root,
			name: "test",
			selection: { backend: "codex", model: "", profile: "" },
		});
		await ledger.append("session", { type: "recovery", description: "original" });
		const first = ledger.page("session", 0, 1);
		assert.equal(first.next, 1);
		assert.equal(first.through, 2);
		await ledger.append("session", { type: "recovery", description: "arrived later" });
		const last = ledger.page("session", first.next, 1, first.through);
		assert.deepEqual(
			last.events.map((event) => event.sequence),
			[2],
		);
		assert.equal(last.next, undefined);
		assert.equal(ledger.page("session").through, 3);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

const invalidRecords = [
	{ data: { type: "turn", turnId: "turn", nativeRecordId: "native", status: "invalid" } },
	{ data: { type: "native", record: { id: "native", status: "available" } } },
	{ data: { type: "approval", approval: { id: "approval", status: "pending", expiresAt: -1 } } },
	{ data: { type: "task", task: { id: "task", status: "completed", result: {} } } },
	{ data: { type: "runtime", turnId: "turn", nativeRecordId: "native", event: { type: "text", text: "bad" } } },
	{ data: { type: "future_event" } },
	{ time: -1, data: { type: "recovery", description: "bad clock" } },
	{ id: "", data: { type: "recovery", description: "bad ID" } },
];
for (const [index, invalid] of invalidRecords.entries()) {
	test(`R06: malformed complete journal payload ${index} fails at load without rewriting evidence`, async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "relay-invalid-ledger-"));
		try {
			const ledger = new SessionLedger(root);
			await ledger.load();
			await ledger.append("session", {
				type: "created",
				workspace: root,
				name: "test",
				selection: { backend: "codex", model: "", profile: "" },
			});
			const path = join(root, "session.jsonl");
			const bytes = `${await readFile(path, "utf8")}${JSON.stringify({ version: 1, id: "invalid", sessionId: "session", sequence: 2, time: 0, ...invalid })}\n`;
			await writeFile(path, bytes);
			await assert.rejects(new SessionLedger(root).load(), /Invalid journal session.jsonl at sequence 2/);
			assert.equal(await readFile(path, "utf8"), bytes);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("Q01: Glob denies external and parent patterns and external search roots; ordinary project patterns work", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-glob-"));
	try {
		const project = join(root, "project");
		const outside = join(root, "outside");
		await mkdir(project);
		await mkdir(outside);
		await symlink(outside, join(project, "link"));
		const gate = new PermissionGate();
		for (const input of [
			{ pattern: `${outside}/*` },
			{ pattern: "../*" },
			{ pattern: "**/../*" },
			{ pattern: "{src,../outside}/*" },
			{ pattern: "link/*" },
			{ pattern: "*", path: outside },
			{ pattern: "*", path: "link" },
		])
			assert.equal(await gate.check("read-only", project, "Glob", input, async () => {}), false);
		assert.equal(await gate.check("read-only", project, "Glob", { pattern: "**/*.ts" }, async () => {}), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Q02: slow mutation stays pending and delivers late completion; query deadline and disconnect are distinct", async () => {
	const requests = new DesktopRequests();
	let id = "";
	let slow!: () => void;
	const delayed = new Promise<void>((resolve) => {
		slow = resolve;
	});
	let settled = false;
	const result = requests
		.request(
			{ type: "project", path: "/test" },
			(value) => {
				id = value;
			},
			slow,
			5,
		)
		.then((value) => {
			settled = true;
			return value;
		});
	await delayed;
	assert.equal(settled, false);
	requests.complete(id, "saved");
	assert.equal(await result, "saved");
	const query = requests.request(
		{ type: "state" },
		() => {},
		() => {},
		5,
	);
	await assert.rejects(query, /Query .* timed out/);
	const unknown = requests.request(
		{ type: "project", path: "/test" },
		() => {},
		() => {},
	);
	requests.disconnected();
	await assert.rejects(unknown, /completion is unknown/);
});
