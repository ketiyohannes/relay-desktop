import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { AccountExhaustedError, UncertainExecutionError } from "../../src/core/desktop/engines.ts";
import { type DesktopEngine, DesktopRuntime } from "../../src/core/desktop/runtime.ts";
import { DesktopStore } from "../../src/core/desktop/store.ts";
import { DesktopTimeline } from "../../src/core/desktop/timeline.ts";

const execute = promisify(execFile);

test(
	"uncertain snapshot reviews preserve their environment and do not continue an account switch",
	{ timeout: 15000 },
	async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "relay-review-recovery-"));
		let exported: string | undefined;
		try {
			await execute("git", ["init", "-q", root]);
			await writeFile(join(root, "source.ts"), "export const value = 1;\n");
			await execute("git", ["add", "source.ts"], { cwd: root });
			await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "baseline"], {
				cwd: root,
			});
			let calls = 0;
			let busy = false;
			let finish!: () => void;
			const settled = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const runtime = new DesktopRuntime(
				join(root, "data"),
				{
					state: (state) => {
						if (state.busySession) busy = true;
						else if (busy) finish();
					},
					permission: async () => false,
				},
				async (session, _account, _prompt, abort) => {
					calls++;
					exported = session.project;
					await runtime.command({
						type: "select_account",
						sessionId: session.id,
						accountId: "second",
						autoSwitch: true,
					});
					assert.equal(abort.signal.aborted, true);
					throw new UncertainExecutionError("Worker may still be acting");
				},
				undefined,
				[],
			);
			await runtime.initialize();
			runtime.store.state.projects.push(root);
			for (const id of ["first", "second"])
				runtime.store.state.accounts.push({
					id,
					name: id,
					engine: "claude",
					provider: "",
					model: "fixture",
					configDir: "",
				});
			await runtime.command({ type: "session", project: root });
			const session = runtime.store.state.sessions[0];
			const snapshot = await new DesktopTimeline(root, session.id).checkpoint("Baseline");
			const action = runtime.store.append(session, { kind: "checkpoint", text: "Baseline", ...snapshot });
			await runtime.command({ type: "review_snapshot", sessionId: session.id, actionId: action.id });
			await settled;
			assert.equal(calls, 1);
			assert.ok(exported);
			assert.equal(await readFile(join(exported, "source.ts"), "utf8"), "export const value = 1;\n");
			const reloaded = new DesktopStore(join(root, "data"));
			await reloaded.load();
			assert.ok(
				reloaded
					.session(session.id)
					.actions.some((entry) => entry.text.includes(`retained for reconciliation: ${exported}`)),
			);
		} finally {
			if (exported) await rm(exported, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("extracted desktop preserves quota rotation, completed effects, and persisted model choices", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-product-"));
	try {
		const calls: string[] = [];
		let busy = false;
		let finish!: () => void;
		const settled = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const engine: DesktopEngine = async (session, account, prompt, _abort, callbacks) => {
			calls.push(account.id);
			if (account.id === "first") {
				await writeFile(join(root, "result"), "saved");
				await callbacks.tool("write", "write", { path: "result" }, "Saved");
				throw new AccountExhaustedError("usage_limit_reached");
			}
			assert.match(prompt, /Do not replay completed/);
			assert.equal(await readFile(join(root, "result"), "utf8"), "saved");
			assert.equal(session.actions.filter((action) => action.kind === "tool").length, 1);
			assert.equal(account.model, "selected");
			await callbacks.text("reply", "Continued", true);
		};
		const runtime = new DesktopRuntime(
			join(root, "data"),
			{
				state: (state) => {
					if (state.busySession) busy = true;
					else if (busy) finish();
				},
				permission: async () => false,
			},
			engine,
			async (account) => ({
				connected: true,
				configDir: "",
				models: [
					{
						provider: "",
						id: account.id === "second" ? "selected" : "default",
						name: "Fixture",
						authenticated: true,
					},
				],
			}),
			[],
		);
		await runtime.initialize();
		runtime.store.state.projects.push(root);
		for (const id of ["first", "second"])
			runtime.store.state.accounts.push({
				id,
				name: id,
				engine: "claude",
				provider: "",
				model: "default",
				configDir: "",
			});
		await runtime.command({ type: "session", project: root });
		const session = runtime.store.state.sessions[0];
		session.models = { second: "selected" };
		await runtime.command({ type: "prompt", sessionId: session.id, text: "Write" });
		await settled;
		assert.deepEqual(calls, ["first", "second"]);
		assert.equal(session.actions.find((action) => action.kind === "tool")?.status, "done");
		const reloaded = new DesktopStore(join(root, "data"));
		await reloaded.load();
		assert.deepEqual(reloaded.session(session.id).models, { second: "selected" });
		assert.equal(reloaded.session(session.id).actions.at(-1)?.text, "Continued");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("extracted snapshot timeline preserves transient files and leaves Git HEAD and index unchanged", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-product-timeline-"));
	try {
		await execute("git", ["init", "-q", root]);
		await writeFile(join(root, "base"), "original\n");
		await execute("git", ["add", "base"], { cwd: root });
		await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "baseline"], {
			cwd: root,
		});
		await writeFile(join(root, "base"), "staged\n");
		await execute("git", ["add", "base"], { cwd: root });
		await writeFile(join(root, "base"), "working\n");
		const index = await readFile(join(root, ".git", "index"));
		const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout;
		const timeline = new DesktopTimeline(root, "session");
		await timeline.checkpoint("Baseline");
		await writeFile(join(root, "transient.ts"), "export const value = 42;\n");
		const added = await timeline.checkpoint("Added");
		await rm(join(root, "transient.ts"));
		const removed = await timeline.checkpoint("Removed");
		assert.equal(removed.previous, added.snapshot);
		const view = await timeline.view(removed.snapshot, added.snapshot, "transient.ts");
		assert.match(view.before ?? "", /value = 42/);
		assert.equal(view.after, "");
		assert.deepEqual(await readFile(join(root, ".git", "index")), index);
		assert.equal((await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout, head);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("extracted desktop persists read-only policy and rejects symlink escapes and shell tools", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-product-policy-"));
	try {
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		await writeFile(join(workspace, "source"), "public");
		await writeFile(join(root, "outside"), "private");
		await symlink(join(root, "outside"), join(workspace, "linked"));
		const results: boolean[] = [];
		let finish!: () => void;
		const settled = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let busy = false;
		const runtime = new DesktopRuntime(
			join(root, "data"),
			{
				state: (state) => {
					if (state.busySession) busy = true;
					else if (busy) finish();
				},
				permission: async () => {
					throw new Error("Read-only tools must not request broad permission");
				},
			},
			async (_session, _account, _prompt, _abort, callbacks) => {
				assert.equal(callbacks.readOnly, true);
				for (const [tool, input] of [
					["Read", { file_path: "source" }],
					["Read", { file_path: "linked" }],
					["Edit", {}],
					["Bash", {}],
				] as const)
					results.push(await callbacks.permission(tool, input));
			},
			undefined,
			[],
		);
		await runtime.initialize();
		runtime.store.state.projects.push(workspace);
		runtime.store.state.accounts.push({
			id: "account",
			name: "Fixture",
			engine: "claude",
			provider: "",
			model: "fixture",
			configDir: "",
		});
		await runtime.command({ type: "session", project: workspace });
		const session = runtime.store.state.sessions[0];
		await runtime.command({ type: "session_permissions", sessionId: session.id, mode: "read-only" });
		await runtime.command({ type: "prompt", sessionId: session.id, text: "Inspect" });
		await settled;
		assert.deepEqual(results, [true, false, false, false]);
		const reloaded = new DesktopStore(join(root, "data"));
		await reloaded.load();
		assert.equal(reloaded.session(session.id).permissionMode, "read-only");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
