import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LedgerEvent, RuntimeAdapter } from "../src/contracts.ts";
import { ApprovalPresenter } from "../src/desktop/approvals.ts";
import { accountSelection, DesktopEngineBridge, projectEvents, publicHistory } from "../src/desktop/engines.ts";
import type { DesktopSession, DesktopState } from "../src/desktop/types.ts";
import { RelayApplication } from "../src/service/application.ts";
import { RelayServer } from "../src/service/server.ts";

test("desktop projects task results once and exposes uncertain execution without worker transcript takeover", () => {
	const session: DesktopSession = {
		id: "parent",
		project: "/workspace",
		name: "Parent",
		accountId: "",
		autoSwitch: true,
		updated: 1,
		actions: [],
	};
	const task = {
		id: "worker",
		parentTurnId: "turn",
		parentNativeId: "native",
		objective: "Find refund deadline",
		permissionMode: "ask" as const,
		status: "running" as const,
	};
	const events: LedgerEvent[] = [
		{ version: 1, id: "start", sessionId: session.id, sequence: 1, time: 1, data: { type: "task", task } },
		{
			version: 1,
			id: "private-worker",
			sessionId: session.id,
			sequence: 2,
			time: 2,
			data: {
				type: "runtime",
				turnId: "worker-turn",
				nativeRecordId: "worker-native",
				taskId: task.id,
				event: { type: "text", id: "reply", text: "Worker stream", complete: true },
			},
		},
		{
			version: 1,
			id: "result",
			sessionId: session.id,
			sequence: 3,
			time: 3,
			data: {
				type: "task",
				task: {
					...task,
					status: "completed",
					result: {
						status: "completed",
						summary: "30 days",
						findings: ["Deadline confirmed"],
						evidence: [{ id: "url", uri: "https://example.test/refunds", description: "Refund policy" }],
						actions: [],
						finalEnvironment: { workspace: session.project, resource: "browser", state: "Idle" },
						blockers: [],
						pendingApprovalIds: [],
					},
				},
			},
		},
		{
			version: 1,
			id: "unknown",
			sessionId: session.id,
			sequence: 4,
			time: 4,
			data: { type: "turn", turnId: "turn", nativeRecordId: "native", status: "unknown" },
		},
	];
	projectEvents(session, events);
	projectEvents(session, events);
	assert.equal(session.actions.filter((action) => action.id === "task:worker").length, 1);
	assert.equal(session.actions[0].status, "done");
	assert.match(session.actions[0].output ?? "", /https:\/\/example.test\/refunds/);
	assert.equal(
		session.actions.some((action) => action.text === "Worker stream"),
		false,
	);
	assert.equal(session.actions.filter((action) => action.kind === "error").length, 1);
	assert.match(session.actions[1].text, /reconcile/);
});

test("desktop imports public history once, persists choices, and discovers CLI sessions", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-desktop-"));
	try {
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const app = new RelayApplication(join(root, "app"), []);
		await app.initialize();
		const server = new RelayServer(app, join(root, "app"));
		const bridge = new DesktopEngineBridge(root, async () => ({
			request: (command) => server.command(command),
			subscribe: (listener) => app.subscribe(listener),
			onDisconnect: () => () => {},
		}));
		const state: DesktopState = {
			projects: [workspace],
			accounts: [{ id: "claude", name: "Claude", engine: "claude", configDir: "", provider: "", model: "old" }],
			sessions: [
				{
					id: "desktop",
					project: workspace,
					name: "Existing",
					updated: 1,
					accountId: "claude",
					autoSwitch: true,
					actions: [
						{ id: "user", time: 1, kind: "user", text: "Existing prompt" },
						{ id: "private", time: 2, kind: "assistant", channel: "analysis", text: "private" },
					],
				},
			],
		};
		await bridge.synchronize(state);
		assert.equal(app.ledger.get("desktop").events.filter((event) => event.data.type === "import").length, 1);
		assert.equal(JSON.stringify(publicHistory(state.sessions[0])).includes("private"), false);
		state.sessions[0].models = { claude: "new" };
		await bridge.select(state.sessions[0], state.accounts[0]);
		await bridge.synchronize(state);
		assert.equal(state.sessions[0].models.claude, "new");
		assert.equal(state.accounts.length, 1);
		await app.create(
			workspace,
			{ backend: "codex", model: "codex", profile: "", options: { effort: "high" } },
			"CLI session",
			"cli",
		);
		await app.append("cli", { type: "user", turnId: "cli-user", text: "CLI prompt" });
		await bridge.synchronize(state);
		await bridge.synchronize(state);
		const cli = state.sessions.find((session) => session.id === "cli")!;
		assert.equal(cli.actions.filter((action) => action.text === "CLI prompt").length, 1);
		assert.equal(app.ledger.get("cli").events.filter((event) => event.data.type === "import").length, 0);
		assert.deepEqual(
			accountSelection(state.accounts.find((account) => account.id === cli.accountId)!),
			app.ledger.get("cli").selection,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("desktop recovers running state and pending approval from a snapshot beyond its projection cursor", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-desktop-approval-"));
	try {
		const app = new RelayApplication(join(root, "app"), []);
		await app.initialize();
		await app.create(root, { backend: "codex", profile: "", model: "" }, "CLI", "cli");
		await app.append("cli", { type: "turn", nativeRecordId: "native", turnId: "turn", status: "running" });
		await app.append("cli", {
			type: "approval",
			approval: {
				id: "approval",
				nativeRecordId: "native",
				turnId: "turn",
				tool: "bash",
				input: {},
				expiresAt: Date.now() + 10000,
				status: "pending",
			},
		});
		const server = new RelayServer(app, join(root, "app"));
		const bridge = new DesktopEngineBridge(root, async () => ({
			request: (command) => server.command(command),
			subscribe: (listener) => app.subscribe(listener),
			onDisconnect: () => () => {},
		}));
		const state: DesktopState = { projects: [], sessions: [], accounts: [] };
		let presented = 0;
		let running = false;
		const presenter = new ApprovalPresenter(
			async () => {
				presented++;
				return false;
			},
			async () => {},
		);
		const recover: Parameters<DesktopEngineBridge["synchronize"]>[1] = (_local, global) => {
			running = global.turns.some((turn) => turn.status === "running");
			for (const approval of global.approvals) presenter.update(global.id, approval);
		};
		await bridge.synchronize(state, recover);
		await bridge.synchronize(state, recover);
		assert.equal(running, true);
		assert.equal(presented, 1);
		assert.equal(state.sessions[0].relayLedgerSequence, app.ledger.get("cli").events.at(-1)?.sequence);
		presenter.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("desktop run does not import the new prompt twice and its projection survives restart", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-desktop-run-"));
	try {
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
				nativeId: "native",
				submit: async (input, emit) => {
					assert.equal(input.handoff?.conversation.filter((message) => message.text === "New prompt").length, 0);
					await emit({ type: "accepted" });
					await emit({ type: "text", id: "message", text: "Partial", complete: false });
					await emit({ type: "done", status: "completed" });
				},
				respond: async () => "expired",
				cancel: async () => "requested",
				release: async () => "settled",
			}),
		};
		const app = new RelayApplication(join(root, "app"), [adapter]);
		await app.initialize();
		const server = new RelayServer(app, join(root, "app"));
		const bridge = new DesktopEngineBridge(root, async () => ({
			request: (command) => server.command(command),
			subscribe: (listener) => app.subscribe(listener),
			onDisconnect: () => () => {},
		}));
		const session: DesktopSession = {
			id: "session",
			project: root,
			name: "Session",
			accountId: "codex",
			autoSwitch: true,
			updated: 1,
			actions: [{ id: "user-operation", time: 1, kind: "user", text: "New prompt" }],
		};
		await bridge.run(
			session,
			{ id: "codex", name: "Codex", engine: "pi", provider: "openai-codex", model: "", configDir: "" },
			"New prompt",
			new AbortController(),
			{
				text: async () => {},
				tool: async () => {},
				checkpoint: async () => {},
				session: async () => {},
				permission: async () => false,
				event: async (event) => {
					projectEvents(session, [event]);
					session.relayLedgerSequence = event.sequence;
				},
			},
		);
		assert.equal(session.actions.filter((action) => action.text === "New prompt").length, 1);
		assert.equal(session.actions.filter((action) => action.text === "Partial").length, 1);
		projectEvents(
			session,
			app.ledger.get(session.id).events.filter((event) => event.sequence > session.relayLedgerSequence!),
		);
		assert.equal(session.actions.filter((action) => action.text === "Partial").length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("manual editor saves participate in the application workspace lease", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-edit-"));
	try {
		const app = new RelayApplication(join(root, "app"), []);
		await app.initialize();
		await app.create(root, { backend: "codex", model: "", profile: "" }, "Session", "session");
		await writeFile(join(root, "file.txt"), "before");
		const lease = await app.resources.acquire(`workspace:${root}`, "native-writer");
		await assert.rejects(app.edit("session", "op", "file.txt", "before", "after"), /Resource locked/);
		await app.resources.release(lease);
		assert.equal((await app.edit("session", "op", "file.txt", "before", "after")).content, "after");
		await assert.rejects(app.edit("session", "op", "file.txt", "before", "after"), /already recorded/);
		assert.ok(
			app.ledger
				.get("session")
				.events.some((event) => event.data.type === "manual_edit" && event.data.status === "completed"),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("desktop sessions without accounts retain browsing state and share review notes", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-desktop-notes-"));
	try {
		const app = new RelayApplication(join(root, "app"), []);
		await app.initialize();
		const server = new RelayServer(app, join(root, "app"));
		const bridge = new DesktopEngineBridge(root, async () => ({
			request: (command) => server.command(command),
			subscribe: (listener) => app.subscribe(listener),
			onDisconnect: () => () => {},
		}));
		const state: DesktopState = {
			projects: [root],
			accounts: [],
			sessions: [
				{
					id: "no-account",
					project: root,
					name: "Browse",
					accountId: "",
					autoSwitch: true,
					updated: 1,
					actions: [{ id: "review", time: 1, kind: "review", text: "Check boundary", snapshot: "a".repeat(40) }],
				},
			],
		};
		await bridge.synchronize(state);
		await bridge.recordNotes(state);
		await bridge.synchronize(state);
		assert.equal(state.accounts.length, 0);
		assert.equal(state.sessions[0].accountId, "");
		assert.equal(app.ledger.get("no-account").events.filter((event) => event.data.type === "note").length, 1);
		const copy: DesktopSession = { ...state.sessions[0], actions: [] };
		projectEvents(copy, app.ledger.get("no-account").events);
		assert.equal(copy.actions.find((action) => action.kind === "review")?.text, "Check boundary");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
