import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type {
	Backend,
	Capability,
	OpenInput,
	RuntimeAdapter,
	RuntimeConnection,
	RuntimeEvent,
	RuntimeSelection,
	TurnInput,
} from "../../src/core/contracts.ts";
import { prepareHandoff } from "../../src/core/handoffs/context.ts";
import { RelayApplication } from "../../src/core/service/application.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Script = (
	input: TurnInput,
	emit: (event: RuntimeEvent) => Promise<void>,
	open: OpenInput,
	connection: FakeConnection,
) => Promise<void>;
class FakeConnection implements RuntimeConnection {
	readonly nativeId = randomUUID();
	private readonly input: OpenInput;
	private readonly script: Script;
	cancelled = false;
	released = false;
	onCancel?: () => void;
	onRespond?: () => Promise<void>;
	releaseStatus: "settled" | "unknown" = "settled";
	cancelStatus: "requested" | "unsupported" = "requested";
	readonly responses: { id: string; allowed: boolean }[] = [];
	constructor(input: OpenInput, script: Script) {
		this.input = input;
		this.script = script;
	}
	submit(input: TurnInput, emit: (event: RuntimeEvent) => Promise<void>): Promise<void> {
		return this.script(input, emit, this.input, this);
	}
	async respond(id: string, allowed: boolean): Promise<"sent"> {
		this.responses.push({ id, allowed });
		await this.onRespond?.();
		return "sent";
	}
	async cancel(): Promise<"requested" | "unsupported"> {
		this.cancelled = true;
		this.onCancel?.();
		return this.cancelStatus;
	}
	async release(): Promise<"settled" | "unknown"> {
		this.released = true;
		return this.releaseStatus;
	}
}
class FakeAdapter implements RuntimeAdapter {
	readonly backend: Backend;
	readonly opens: OpenInput[] = [];
	readonly connections: FakeConnection[] = [];
	script: Script = async (_input, emit) => {
		await emit({ type: "accepted" });
		await emit({ type: "done", status: "completed" });
	};
	constructor(backend: Backend) {
		this.backend = backend;
	}
	async discover(): Promise<Capability> {
		return {
			resume: true,
			cancel: "interrupt",
			approvals: "native",
			compaction: "native",
			tools: [],
			mcp: false,
			limitations: [],
		};
	}
	async open(input: OpenInput): Promise<RuntimeConnection> {
		this.opens.push(structuredClone({ ...input, delegate: undefined }));
		const connection = new FakeConnection(input, this.script);
		this.connections.push(connection);
		return connection;
	}
}
function selected(backend: Backend): RuntimeSelection {
	return backend === "pi"
		? { backend, profile: "", model: "kimi", options: { provider: "moonshot" } }
		: { backend, profile: "", model: backend };
}
async function fixture(settlementMs?: number) {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-app-"));
	roots.push(root);
	const workspace = join(root, "project");
	await mkdir(workspace);
	const adapters = { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude"), pi: new FakeAdapter("pi") };
	const app = new RelayApplication(join(root, "app"), Object.values(adapters), settlementMs);
	await app.initialize();
	const session = await app.create(workspace, selected("codex"));
	return { app, session, workspace, root, adapters };
}

test("Codex → Claude → Kimi preserves workspace, public evidence, and multiple native mappings", async () => {
	const { app, session, workspace, adapters } = await fixture();
	let writes = 0;
	adapters.codex.script = async (_input, emit) => {
		await emit({ type: "accepted", nativeTurnId: "codex-turn" });
		await emit({ type: "tool_start", id: "write", name: "write", input: { path: "done.txt" } });
		await writeFile(join(workspace, "done.txt"), "done");
		writes++;
		await emit({ type: "tool_end", id: "write", name: "write", output: "done.txt written", failed: false });
		await emit({ type: "text", id: "answer", text: "Implemented change", complete: true });
		await emit({ type: "done", status: "completed" });
	};
	assert.equal(await app.submit(session.id, "Make the change"), "completed");
	adapters.claude.script = async (input, emit) => {
		assert.equal(input.handoff?.workspace, workspace);
		assert.ok(input.handoff?.completedOutcomes.some((outcome) => outcome.outcome.includes("done.txt")));
		assert.equal(await readFile(join(workspace, "done.txt"), "utf8"), "done");
		assert.equal("toolCalls" in input.handoff!, false);
		await emit({ type: "accepted" });
		await emit({ type: "text", id: "claude-answer", text: "Reviewed change", complete: true });
		await emit({ type: "compaction", description: "Native compacted" });
		await emit({ type: "done", status: "completed" });
	};
	await app.select(session.id, selected("claude"));
	await app.submit(session.id, "Review it");
	adapters.pi.script = async (input, emit) => {
		assert.ok(input.handoff?.conversation.some((message) => message.text === "Reviewed change"));
		await emit({ type: "accepted" });
		await emit({ type: "done", status: "completed" });
	};
	await app.select(session.id, selected("pi"));
	await app.submit(session.id, "Continue");
	await app.select(session.id, selected("codex"));
	adapters.codex.script = async (input, emit, open) => {
		assert.ok(open.record.nativeId);
		assert.ok(open.record.receivedThrough > 0);
		assert.ok(input.handoff?.conversation.some((message) => message.text === "Reviewed change"));
		await emit({ type: "accepted" });
		await emit({ type: "done", status: "completed" });
	};
	await app.submit(session.id, "Finish");
	assert.equal(writes, 1);
	assert.equal(app.ledger.get(session.id).natives.length, 3);
	assert.ok(
		app.ledger
			.get(session.id)
			.events.some((event) => event.data.type === "runtime" && event.data.event.type === "compaction"),
	);
});

test("same operation ID does not execute a completed command again", async () => {
	const { app, session, adapters } = await fixture();
	let executions = 0;
	adapters.codex.script = async (_input, emit) => {
		executions++;
		await emit({ type: "accepted" });
		await emit({ type: "done", status: "completed" });
	};
	assert.equal(await app.submit(session.id, "write", "ask", "operation-1"), "completed");
	assert.equal(await app.submit(session.id, "write", "ask", "operation-1"), "completed");
	assert.equal(executions, 1);
});

test("deduplicated turns do not transfer execution ownership to another frontend", async () => {
	const { app, session, adapters } = await fixture();
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let reservations = 0;
	adapters.codex.script = async (_input, emit) => {
		started();
		await pending;
		await emit({ type: "done", status: "completed" });
	};
	const run = app.submit(session.id, "Original", "ask", "shared-operation", undefined, () => {
		reservations++;
	});
	await ready;
	assert.equal(
		await app.submit(session.id, "Retry", "ask", "shared-operation", undefined, () => {
			reservations++;
		}),
		"running",
	);
	assert.equal(reservations, 1);
	finish();
	await run;
});

test("two frontends cannot send conflicting responses to one native approval", async () => {
	const { app, session, adapters } = await fixture();
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	adapters.codex.script = async (_input, emit) => {
		await emit({ type: "approval", id: "shared-approval", tool: "bash", input: {} });
		started();
		await pending;
		await emit({ type: "done", status: "completed" });
	};
	const run = app.submit(session.id, "Ask");
	await ready;
	const results = await Promise.allSettled([
		app.respond(session.id, "shared-approval", true),
		app.respond(session.id, "shared-approval", false),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(adapters.codex.connections[0].responses.length, 1);
	finish();
	await run;
});

test("cancellation during an approval response never sends a conflicting native answer", async () => {
	const { app, session, adapters } = await fixture();
	let ready!: () => void;
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	let answer!: () => void;
	const responding = new Promise<void>((resolve) => {
		answer = resolve;
	});
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	adapters.codex.script = async (_input, emit, _open, connection) => {
		connection.onRespond = () => responding;
		connection.onCancel = finish;
		await emit({ type: "approval", id: "racing", tool: "write", input: {} });
		ready();
		await pending;
		await emit({ type: "done", status: "cancelled" });
	};
	const run = app.submit(session.id, "Ask");
	await started;
	const response = app.respond(session.id, "racing", true);
	const cancellation = app.cancel(session.id);
	answer();
	await Promise.all([response, cancellation, run]);
	assert.deepEqual(adapters.codex.connections[0].responses, [{ id: "racing", allowed: true }]);
	assert.equal(app.ledger.get(session.id).approvals[0].status, "interrupted");
});

test("uncooperative cancellation settles as unknown, retains ownership, and rejects late observations", async () => {
	const { app, session, adapters } = await fixture(20);
	let ready!: () => void;
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	let lateEmit!: (event: RuntimeEvent) => Promise<void>;
	adapters.codex.script = async (_input, emit, _open, connection) => {
		lateEmit = emit;
		connection.cancel = () => new Promise(() => {});
		connection.release = () => new Promise(() => {});
		ready();
		await new Promise(() => {});
	};
	const run = app.submit(session.id, "Work", "ask", "stuck");
	await started;
	assert.equal(await app.cancel(session.id), "unknown");
	assert.equal(await run, "unknown");
	await assert.rejects(lateEmit({ type: "done", status: "completed" }), /already settled/);
	assert.equal(app.ledger.get(session.id).turns[0].status, "unknown");
	await assert.rejects(app.resources.acquire(`workspace:${session.workspace}`, "another"), /Resource locked/);
	await assert.rejects(app.submit(session.id, "Continue"), /Reconcile/);
});

test("structured worker evidence distinguishes reported actions and pending blockers", async () => {
	const { app, session, adapters } = await fixture();
	await app.select(session.id, selected("pi"));
	adapters.claude.script = async (_input, emit) => {
		await emit({
			type: "worker_result",
			report: {
				summary: "Policy located",
				findings: ["Refund within 30 days"],
				evidence: [{ id: "policy", uri: "https://example.test/policy", description: "Refund deadline" }],
				actions: [{ description: "Read the policy", effect: "none" }],
				environmentState: "Policy tab remains open",
				blockers: ["Purchase submission requires approval"],
			},
		});
		await emit({ type: "done", status: "completed" });
	};
	adapters.pi.script = async (_input, emit, open) => {
		const result = await open.delegate!(
			{
				selection: selected("claude") as Exclude<RuntimeSelection, { backend: "pi" }>,
				objective: "Find policy",
				resource: "browser:policy",
			},
			new AbortController().signal,
		);
		assert.equal(result.status, "blocked");
		assert.equal(result.finalEnvironment.state, "Policy tab remains open");
		assert.deepEqual(result.findings, ["Refund within 30 days"]);
		assert.equal(result.actions[0].description, "Worker reported: Read the policy");
		await emit({ type: "done", status: "completed" });
	};
	assert.equal(await app.submit(session.id, "Find policy"), "completed");
	assert.equal(app.ledger.get(session.id).tasks[0].status, "blocked");
});

test("failed context submission leaves coverage unchanged and quarantines ambiguous effects", async () => {
	const { app, session, adapters } = await fixture();
	adapters.codex.script = async () => {
		throw new Error("Disconnected after write to transport");
	};
	assert.equal(await app.submit(session.id, "write"), "unknown");
	const native = app.ledger.get(session.id).natives[0];
	assert.equal(native.receivedThrough, 0);
	assert.equal(native.status, "unknown");
	await assert.rejects(app.submit(session.id, "retry"), /Reconcile/);
	const another = await app.create(session.workspace, selected("claude"));
	await assert.rejects(app.submit(another.id, "write elsewhere"), /Workspace has unreconciled/);
});

test("only one writer may use a canonical workspace", async () => {
	const { app, session, adapters } = await fixture();
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	adapters.codex.script = async (_input, emit) => {
		started();
		await pending;
		await emit({ type: "done", status: "completed" });
	};
	const run = app.submit(session.id, "hold lease");
	await ready;
	const other = await app.create(session.workspace, selected("claude"));
	await assert.rejects(app.submit(other.id, "write"), /Resource locked/);
	await assert.rejects(app.select(session.id, selected("claude")), /Cancel and wait/);
	finish();
	await run;
	assert.equal(await app.submit(other.id, "write"), "completed");
});

test("Kimi delegates one bounded browser task without switching the parent conversation", async () => {
	const { app, session, adapters } = await fixture();
	await app.select(session.id, selected("pi"));
	adapters.claude.script = async (_input, emit, open) => {
		assert.equal(open.record.role, "worker");
		assert.equal(open.permissionMode, "read-only");
		await emit({ type: "accepted" });
		await emit({
			type: "artifact",
			artifact: { id: "policy", uri: "https://example.test/refund", description: "Refund policy evidence" },
		});
		await emit({ type: "text", id: "worker", text: "Deadline is 30 days", complete: true });
		await emit({ type: "done", status: "completed" });
	};
	adapters.pi.script = async (_input, emit, open) => {
		await emit({ type: "accepted" });
		const result = await open.delegate!(
			{
				selection: selected("claude") as Exclude<RuntimeSelection, { backend: "pi" }>,
				objective: "Find refund policy and deadline",
				permissionMode: "read-only",
				resource: "browser:refund",
			},
			new AbortController().signal,
		);
		assert.equal(result.summary, "Deadline is 30 days");
		assert.equal(result.evidence[0].uri, "https://example.test/refund");
		await emit({ type: "text", id: "parent", text: "Policy found", complete: true });
		await emit({ type: "done", status: "completed" });
	};
	assert.equal(await app.submit(session.id, "Find the policy", "read-only"), "completed");
	const final = app.ledger.get(session.id);
	assert.equal(final.selection.backend, "pi");
	assert.equal(final.tasks[0].status, "completed");
	const record = final.natives.find((record) => record.role === "foreground")!;
	const handoff = prepareHandoff(
		final,
		{ ...record, id: "foreign-native", nativeId: undefined, receivedThrough: 0 },
		"continue",
	);
	assert.ok(handoff.conversation.some((message) => message.text === "Policy found"));
	assert.equal(
		handoff.conversation.some((message) => message.text === "Deadline is 30 days"),
		false,
	);
});

test("parent cancellation stops child and waits for resource release before another worker", async () => {
	const { app, session, adapters } = await fixture();
	await app.select(session.id, selected("pi"));
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	adapters.claude.script = async (_input, emit, _open, connection) => {
		await new Promise<void>((resolve) => {
			connection.onCancel = resolve;
			started();
		});
		await emit({ type: "done", status: "cancelled" });
	};
	adapters.pi.script = async (_input, emit, open, connection) => {
		await open.delegate!(
			{
				selection: selected("claude") as Exclude<RuntimeSelection, { backend: "pi" }>,
				objective: "Browser task",
				resource: "browser:shared",
			},
			new AbortController().signal,
		);
		await emit({ type: "done", status: connection.cancelled ? "cancelled" : "completed" });
	};
	const run = app.submit(session.id, "delegate");
	await ready;
	assert.equal(await app.cancel(session.id), "requested");
	assert.equal(await run, "cancelled");
	assert.equal(adapters.claude.connections[0].cancelled, true);
	assert.equal(adapters.claude.connections[0].released, true);
	const lease = await app.resources.acquire("browser:shared", "next-worker");
	await app.resources.release(lease);
});

test("approval responses reach the correct native record and cannot be reused", async () => {
	const { app, session, adapters } = await fixture();
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	adapters.codex.script = async (_input, emit) => {
		await emit({ type: "approval", id: "approval-1", tool: "bash", input: { command: "write" } });
		started();
		await pending;
		await emit({ type: "done", status: "completed" });
	};
	const run = app.submit(session.id, "ask");
	await ready;
	await app.respond(session.id, "approval-1", true);
	assert.deepEqual(adapters.codex.connections[0].responses, [{ id: "approval-1", allowed: true }]);
	await assert.rejects(app.respond(session.id, "approval-1", true), /no longer pending/);
	finish();
	await run;
});

test("restart marks execution, tasks, and approvals uncertain; no prompt is replayed", async () => {
	const { app, session, adapters, root } = await fixture();
	const record = {
		id: "native-record",
		selection: selected("codex"),
		workspace: session.workspace,
		branch: "main",
		role: "foreground" as const,
		receivedThrough: 0,
		status: "available" as const,
	};
	await app.append(session.id, { type: "native", record });
	await app.append(session.id, { type: "turn", turnId: "interrupted", nativeRecordId: record.id, status: "running" });
	await app.append(session.id, {
		type: "approval",
		approval: {
			id: "pending",
			nativeRecordId: record.id,
			turnId: "interrupted",
			tool: "bash",
			input: {},
			expiresAt: Date.now() + 1000,
			status: "pending",
		},
	});
	const restarted = new RelayApplication(join(root, "app"), Object.values(adapters));
	await restarted.initialize();
	const recovered = restarted.ledger.get(session.id);
	assert.equal(recovered.turns[0].status, "unknown");
	assert.equal(recovered.approvals[0].status, "interrupted");
	assert.equal(adapters.codex.opens.length, 0);
	await assert.rejects(restarted.submit(session.id, "continue"), /Reconcile/);
	await restarted.reconcile(session.id, "interrupted", "Native process stopped; file contents verified");
	assert.equal(await restarted.submit(session.id, "continue"), "completed");
});

test("torn final journal line is preserved separately; interior corruption is rejected", async () => {
	const { app, session, root } = await fixture();
	const path = join(root, "app", "ledger", `${session.id}.jsonl`);
	await appendFile(path, '{"version":');
	const recovered = new RelayApplication(join(root, "app"), []);
	await recovered.initialize();
	assert.equal(recovered.ledger.get(session.id).id, session.id);
	await appendFile(path, "invalid-json\n");
	const corrupt = new RelayApplication(join(root, "app"), []);
	await assert.rejects(corrupt.initialize());
	assert.equal(app.ledger.get(session.id).id, session.id);
});

test("unfinished tool execution quarantines a cancelled turn even after the process settles", async () => {
	const { app, session, adapters } = await fixture();
	adapters.codex.script = async (_input, emit) => {
		await emit({ type: "accepted" });
		await emit({ type: "tool_start", id: "unfinished", name: "bash", input: { command: "write" } });
		await emit({ type: "done", status: "cancelled" });
	};
	assert.equal(await app.submit(session.id, "Write", "ask", "unfinished-turn"), "unknown");
	await assert.rejects(app.resources.acquire(`workspace:${session.workspace}`, "other"), /Resource locked/);
	await assert.rejects(app.changeWorkspace(session.id, session.workspace), /Reconcile/);
	await app.reconcile(session.id, "unfinished-turn", "Process group absent; inspected partial file effects");
	const lease = await app.resources.acquire(`workspace:${session.workspace}`, "verified");
	await app.resources.release(lease);
});

test("uncertain editor saves block fresh native mappings and workspace changes", async () => {
	const { app, session, workspace } = await fixture();
	await writeFile(join(workspace, "file.txt"), "current");
	await assert.rejects(app.edit(session.id, "edit-operation", "file.txt", "stale", "replacement"));
	await assert.rejects(app.resetNative(session.id, "Fresh session"), /reconcile/);
	await assert.rejects(app.changeWorkspace(session.id, workspace), /Reconcile/);
	await app.reconcile(session.id, "edit:edit-operation", "No write occurred; current file verified");
	assert.equal(await readFile(join(workspace, "file.txt"), "utf8"), "current");
	await app.resetNative(session.id, "Fresh session after verification");
});

test("concurrent history imports and product notes are durable and deduplicated", async () => {
	const { app, session, root } = await fixture();
	const history = {
		type: "import" as const,
		source: "source",
		messages: [{ id: "m", role: "user" as const, text: "Original request" }],
		outcomes: [],
	};
	await Promise.all([app.importHistory(session.id, history), app.importHistory(session.id, history)]);
	const note = {
		id: "review",
		kind: "review" as const,
		text: "Check this boundary",
		status: "done" as const,
		snapshot: "a".repeat(40),
	};
	await Promise.all([app.recordNote(session.id, note), app.recordNote(session.id, note)]);
	assert.equal(app.ledger.get(session.id).events.filter((event) => event.data.type === "import").length, 1);
	assert.equal(app.ledger.get(session.id).events.filter((event) => event.data.type === "note").length, 1);
	const restarted = new RelayApplication(join(root, "app"), []);
	await restarted.initialize();
	const saved = restarted.ledger.get(session.id);
	const handoff = prepareHandoff(
		saved,
		{
			id: "new",
			selection: selected("claude"),
			workspace: saved.workspace,
			role: "foreground",
			receivedThrough: 0,
			status: "available",
			branch: "main",
		},
		"Continue",
	);
	assert.ok(handoff.decisions.some((decision) => decision.includes("Check this boundary")));
	assert.ok(handoff.artifacts.some((artifact) => artifact.uri.includes("a".repeat(40))));
});

test("unknown browser ownership cannot be reconciled by an unrelated session", async () => {
	const { app, session } = await fixture();
	const lease = await app.resources.acquire("browser:shared", "task-owner");
	await assert.rejects(app.resources.reconcile("browser:shared", [session.id]), /different execution/);
	await assert.rejects(app.resources.acquire("browser:shared", "new-worker"), /Resource locked/);
	await app.resources.release(lease);
});

test("ephemeral turns retain recovery metadata without persisting conversation or tool content", async () => {
	const { app, workspace, root, adapters } = await fixture();
	const session = await app.create(workspace, selected("codex"), "private-name-sentinel", "ephemeral", undefined, true);
	adapters.codex.script = async (_input, emit, open) => {
		assert.equal(open.persist, false);
		await emit({ type: "accepted" });
		await emit({ type: "tool_start", id: "tool", name: "bash", input: { command: "private-command-sentinel" } });
		await emit({ type: "text", id: "answer", text: "private-answer-sentinel", complete: true });
		await emit({ type: "done", status: "cancelled" });
	};
	assert.equal(await app.submit(session.id, "private-prompt-sentinel", "ask", "ephemeral-turn"), "unknown");
	const disk = await readFile(join(root, "app", "ledger", "ephemeral.jsonl"), "utf8");
	assert.equal(disk.includes("private-"), false);
	assert.ok(
		app.ledger
			.get(session.id)
			.events.some((event) => event.data.type === "user" && event.data.text === "private-prompt-sentinel"),
	);
	const restarted = new RelayApplication(join(root, "app"), Object.values(adapters));
	await restarted.initialize();
	assert.equal(restarted.ledger.get(session.id).turns[0].status, "unknown");
	await assert.rejects(restarted.forgetEphemeral(session.id), /reconcile/);
	await restarted.reconcile(session.id, "ephemeral-turn", "Native processes stopped and workspace verified");
	await restarted.forgetEphemeral(session.id);
	assert.equal(restarted.ledger.has(session.id), false);
});

test("restart quarantines a completed turn whose workspace lease was not removed", async () => {
	const { app, session, root, adapters } = await fixture();
	await app.submit(session.id, "Complete", "ask", "finished-turn");
	await app.resources.acquire(`workspace:${session.workspace}`, `${session.id}:finished-turn`);
	const restarted = new RelayApplication(join(root, "app"), Object.values(adapters));
	await restarted.initialize();
	assert.equal(restarted.ledger.get(session.id).turns[0].status, "unknown");
	await assert.rejects(restarted.submit(session.id, "Continue"), /Reconcile/);
	await restarted.reconcile(session.id, "finished-turn", "Verified native execution ended; all file effects inspected");
	assert.equal(await restarted.submit(session.id, "Continue"), "completed");
});
