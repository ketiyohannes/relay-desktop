import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAuthStorage } from "../../src/desktop/codex-auth.ts";
import { DesktopRuntime } from "../../src/desktop/runtime.ts";
import { DesktopTimeline } from "../../src/desktop/timeline.ts";
import { browseDirectory, workspaceFile, workspaceView } from "../../src/desktop/workspace.ts";
import { fakeAccountCatalog } from "./fixtures.ts";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("keeps Stop authoritative when cancellation races with a manual switch checkpoint", async () => {
	const cwd = await repository();
	let begin!: () => void;
	const began = new Promise<void>((resolve) => {
		begin = resolve;
	});
	let checkpoint!: () => void;
	const capturing = new Promise<void>((resolve) => {
		checkpoint = resolve;
	});
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let finish!: () => void;
	const settled = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const original = DesktopTimeline.prototype.checkpoint;
	vi.spyOn(DesktopTimeline.prototype, "checkpoint").mockImplementation(async function (this: DesktopTimeline, label) {
		if (label === "Manual switch settled") {
			checkpoint();
			await blocked;
		}
		return original.call(this, label);
	});
	let started = false;
	const calls: string[] = [];
	const runtime = new DesktopRuntime(
		join(cwd, ".git/relay"),
		{
			state: (state) => {
				if (state.busySession) started = true;
				else if (started) finish();
			},
			permission: async () => true,
		},
		async (_session, account, _prompt, abort) => {
			calls.push(account.name);
			begin();
			await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
			throw new Error("Cancelled");
		},
		fakeAccountCatalog,
	);
	await runtime.initialize();
	await runtime.command({ type: "project", path: cwd });
	for (const name of ["first", "second"])
		await runtime.command({
			type: "account",
			account: { id: "", name, engine: "claude", configDir: "", provider: "", model: "" },
		});
	await runtime.command({ type: "session", project: cwd });
	const session = runtime.store.state.sessions[0];
	await runtime.command({ type: "prompt", sessionId: session.id, text: "Continue" });
	await began;
	await runtime.command({
		type: "select_account",
		sessionId: session.id,
		accountId: runtime.store.state.accounts[1].id,
		autoSwitch: true,
	});
	await capturing;
	await runtime.command({ type: "cancel" });
	release();
	await settled;
	expect(calls).toEqual(["first"]);
});

it("shows changes in a Git project before its first commit", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "relay-unborn-"));
	directories.push(cwd);
	await execute("git", ["init", "-q", cwd]);
	await writeFile(join(cwd, "new.ts"), "const newFile = true;\n");
	expect((await workspaceView(cwd)).changed).toEqual(["new.ts"]);
	expect((await workspaceView(cwd, "new.ts")).diff).toContain("New file");
});
async function repository(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "relay-workspace-"));
	directories.push(cwd);
	await execute("git", ["init", "-q", cwd]);
	await writeFile(join(cwd, "base.ts"), "const original = true;\n");
	await execute("git", ["add", "."], { cwd });
	await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "baseline"], { cwd });
	return cwd;
}

it("browses folders and reads current files before any prompt, including untracked and deleted files", async () => {
	const cwd = await repository();
	await mkdir(join(cwd, "folder"));
	await writeFile(join(cwd, "new.ts"), "const current = true;\n");
	await rm(join(cwd, "base.ts"));
	const browser = await browseDirectory(cwd);
	expect(browser.entries.map((entry) => entry.name)).toContain("folder");
	expect(browser.entries.map((entry) => entry.name)).not.toContain("new.ts");
	const view = await workspaceView(cwd);
	expect(view.changed).toEqual(["base.ts", "new.ts"]);
	expect(view.files).toEqual(["new.ts"]);
	expect((await workspaceView(cwd, "new.ts")).after).toContain("current");
	expect((await workspaceView(cwd, "base.ts")).before).toContain("original");
});

it("filters tracked, untracked and deleted ignored files using Git rules and explicit directory exclusions", async () => {
	const cwd = await repository();
	const paths = [
		".github/workflow.yml",
		"node_modules/pkg.js",
		"nested/node_modules/pkg.js",
		"generated.ts",
		"deleted.log",
		"nested/drop.cache",
		"nested/keep.cache",
		"visible.ts",
	];
	for (const folder of [".github", "node_modules", "nested/node_modules"])
		await mkdir(join(cwd, folder), { recursive: true });
	await writeFile(join(cwd, ".gitignore"), "generated.ts\n*.log\n");
	await writeFile(join(cwd, "nested/.gitignore"), "*.cache\n!keep.cache\n");
	for (const path of paths) await writeFile(join(cwd, path), "before\n");
	await execute("git", ["add", "-f", "--", ".gitignore", "nested/.gitignore", ...paths], { cwd });
	await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "fixtures"], { cwd });
	for (const path of paths) await writeFile(join(cwd, path), "after\n");
	await rm(join(cwd, "deleted.log"));
	await writeFile(join(cwd, "new.log"), "ignored untracked\n");
	await writeFile(join(cwd, "visible\nname.ts"), "new\n");
	await writeFile(join(cwd, ".git/info/exclude"), "local.ts\n");
	await writeFile(join(cwd, "local.ts"), "local\n");
	const globalIgnore = join(cwd, ".git/global-ignore");
	await writeFile(globalIgnore, "global.ts\n");
	await execute("git", ["config", "core.excludesFile", globalIgnore], { cwd });
	await writeFile(join(cwd, "global.ts"), "global\n");
	expect((await workspaceView(cwd)).changed).toEqual(["nested/keep.cache", "visible\nname.ts", "visible.ts"]);
	// Full-file browsing is still available for tracked files excluded from Changes.
	expect((await workspaceView(cwd, ".github/workflow.yml")).after).toBe("after\n");
	await writeFile(join(cwd, "base.ts"), "outside nested project\n");
	expect((await workspaceView(join(cwd, "nested"))).changed).toEqual(["keep.cache"]);
});

it("filters timeline changes while preserving historical blobs and the user's index", async () => {
	const cwd = await repository();
	await mkdir(join(cwd, ".github"));
	await mkdir(join(cwd, "node_modules"));
	await writeFile(join(cwd, ".github/workflow.yml"), "original workflow\n");
	await writeFile(join(cwd, "node_modules/dependency.js"), "dependency\n");
	await writeFile(join(cwd, "later-ignored.ts"), "original generated\n");
	const timeline = new DesktopTimeline(cwd, "change-filter");
	const baseline = await timeline.checkpoint("baseline");
	await writeFile(join(cwd, "base.ts"), "const edited = true;\n");
	await writeFile(join(cwd, ".github/workflow.yml"), "updated workflow\n");
	await writeFile(join(cwd, "later-ignored.ts"), "updated generated\n");
	await execute("git", ["add", "--", "base.ts"], { cwd });
	const staged = (await execute("git", ["diff", "--cached"], { cwd })).stdout;
	const changed = await timeline.checkpoint("edited");
	expect(changed.files).toEqual(["base.ts", "later-ignored.ts"]);
	await writeFile(join(cwd, ".gitignore"), "later-ignored.ts\n");
	expect((await timeline.view(changed.snapshot, baseline.snapshot)).changed).toEqual(["base.ts"]);
	expect((await timeline.view(changed.snapshot, baseline.snapshot, ".github/workflow.yml")).after).toBe(
		"updated workflow\n",
	);
	expect((await execute("git", ["diff", "--cached"], { cwd })).stdout).toBe(staged);
});

it("filters existing session history for display without rewriting its recorded file list", async () => {
	const cwd = await repository();
	const directory = join(cwd, ".git/relay");
	const runtime = new DesktopRuntime(directory, { state: () => {}, permission: async () => false });
	await runtime.initialize();
	await runtime.command({ type: "project", path: cwd });
	await runtime.command({ type: "session", project: cwd });
	const session = runtime.store.state.sessions[0];
	const files = [".github/workflow.yml", "node_modules/dependency.js", "generated.ts", "base.ts"];
	runtime.store.append(session, { kind: "checkpoint", text: "Old checkpoint", files });
	await runtime.store.save();
	await writeFile(join(cwd, ".gitignore"), "generated.ts\n");
	const loaded = new DesktopRuntime(directory, { state: () => {}, permission: async () => false });
	await loaded.initialize();
	const state = await loaded.command({ type: "state" });
	if (!("sessions" in state)) throw new Error("Expected desktop state");
	expect(state.sessions[0].actions[0].files).toEqual(["base.ts"]);
	expect(loaded.store.state.sessions[0].actions[0].files).toEqual(files);
	await writeFile(join(cwd, ".gitignore"), "");
	await loaded.command({ type: "workspace", sessionId: session.id });
	const refreshed = await loaded.command({ type: "state" });
	if (!("sessions" in refreshed)) throw new Error("Expected desktop state");
	expect(refreshed.sessions[0].actions[0].files).toEqual(["generated.ts", "base.ts"]);
});

it("rejects traversal and symlinks that escape the project root", async () => {
	const cwd = await repository();
	const outside = await repository();
	await symlink(join(outside, "base.ts"), join(cwd, "escape.ts"));
	await expect(workspaceFile(cwd, "escape.ts")).rejects.toThrow("outside the project");
	await expect(workspaceFile(cwd, join("..", outside.split("/").at(-1)!, "base.ts"))).rejects.toThrow(
		"outside the project",
	);
});

it("attributes retained and newly added lines to their original snapshots", async () => {
	const cwd = await repository();
	const timeline = new DesktopTimeline(cwd, "provenance");
	const baseline = await timeline.checkpoint("baseline");
	await writeFile(join(cwd, "base.ts"), "const original = true;\nconst added = 1;\n");
	const added = await timeline.checkpoint("added");
	expect((await timeline.view(added.snapshot, baseline.snapshot, "base.ts")).origins).toEqual([
		baseline.snapshot,
		added.snapshot,
	]);
});

it("retains the full repository and correct file paths when a nested project folder is selected", async () => {
	const cwd = await repository();
	const nested = join(cwd, "package");
	await mkdir(nested);
	await writeFile(join(nested, "child.ts"), "const initial = true;\n");
	const timeline = new DesktopTimeline(nested, "nested");
	const baseline = await timeline.checkpoint("baseline");
	await writeFile(join(nested, "child.ts"), "const edited = true;\n");
	const edited = await timeline.checkpoint("edited");
	const view = await timeline.view(edited.snapshot, baseline.snapshot, "package/child.ts");
	expect(view.files).toEqual(["base.ts", "package/child.ts"]);
	expect(view.before).toContain("initial");
	expect(view.after).toContain("edited");
	expect(view.diff).toContain("-const initial");
});

it("settles an interrupted tool before continuing a manual account switch in the same session", async () => {
	const cwd = await repository();
	let begin!: () => void;
	const began = new Promise<void>((resolve) => {
		begin = resolve;
	});
	let finish!: () => void;
	const settled = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let started = false;
	const accounts: string[] = [];
	const runtime = new DesktopRuntime(
		join(cwd, ".git/relay"),
		{
			state: (state) => {
				if (state.busySession) started = true;
				else if (started) finish();
			},
			permission: async () => true,
		},
		async (session, account, prompt, abort, callbacks) => {
			accounts.push(account.name);
			if (account.name === "first") {
				await callbacks.tool("interrupted", "write", { path: "base.ts" });
				await writeFile(join(cwd, "base.ts"), "const changed = true;\n");
				begin();
				await new Promise<void>((resolve) =>
					abort.signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				throw new Error("Cancelled");
			}
			expect(prompt).toContain("Do not replay");
			expect(session.actions.find((action) => action.toolId === "interrupted")?.status).toBe("error");
			expect(
				session.actions.some((action) => action.kind === "checkpoint" && action.files?.includes("base.ts")),
			).toBe(true);
			await callbacks.text("reply", "Continued", true);
		},
		fakeAccountCatalog,
	);
	await runtime.initialize();
	await runtime.command({ type: "project", path: cwd });
	for (const name of ["first", "second"])
		await runtime.command({
			type: "account",
			account: { id: "", name, engine: "claude", configDir: "", provider: "", model: "" },
		});
	await runtime.command({ type: "session", project: cwd });
	const session = runtime.store.state.sessions[0];
	await runtime.command({ type: "prompt", sessionId: session.id, text: "Change a file" });
	await began;
	await runtime.command({
		type: "select_account",
		sessionId: session.id,
		accountId: runtime.store.state.accounts[1].id,
		autoSwitch: true,
	});
	await settled;
	expect(accounts).toEqual(["first", "second"]);
	expect(session.actions.filter((action) => action.kind === "user")).toHaveLength(1);
	expect(session.actions.some((action) => action.kind === "error")).toBe(false);
});

it("reviews immutable content with tools denied and preserves the native conversation identity", async () => {
	const cwd = await repository();
	let finish!: () => void;
	const settled = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let started = false;
	const runtime = new DesktopRuntime(
		join(cwd, ".git/relay"),
		{
			state: (state) => {
				if (state.busySession) started = true;
				else if (started) finish();
			},
			permission: async () => {
				throw new Error("Review must not request approval");
			},
		},
		async (reviewSession, _account, prompt, _abort, callbacks) => {
			expect(callbacks.readOnly).toBe(true);
			expect(await callbacks.permission("write", {})).toBe(false);
			expect(prompt).toContain("const historical = true");
			expect(prompt).not.toContain("const current = true");
			expect(reviewSession.project).not.toBe(cwd);
			expect(await callbacks.permission("read", { path: "base.ts" })).toBe(true);
			expect(await readFile(join(reviewSession.project, "base.ts"), "utf8")).toContain("historical");
			expect(await callbacks.permission("read", { path: join(cwd, "base.ts") })).toBe(false);
			await callbacks.session("review-native-id");
			await callbacks.text("review", "base.ts:1 — reviewed historical code", true);
		},
		fakeAccountCatalog,
	);
	await runtime.initialize();
	await runtime.command({ type: "project", path: cwd });
	await runtime.command({
		type: "account",
		account: { id: "", name: "reviewer", engine: "claude", configDir: "", provider: "", model: "" },
	});
	await runtime.command({ type: "session", project: cwd });
	const session = runtime.store.state.sessions[0];
	session.claudeSessionId = "original-native-id";
	const timeline = new DesktopTimeline(cwd, session.id);
	await timeline.checkpoint("baseline");
	await writeFile(join(cwd, "base.ts"), "const historical = true;\n");
	const snapshot = await timeline.checkpoint("changed");
	const action = runtime.store.append(session, { kind: "checkpoint", text: "Changed", ...snapshot });
	await writeFile(join(cwd, "base.ts"), "const current = true;\n");
	await runtime.command({ type: "review_snapshot", sessionId: session.id, actionId: action.id });
	await settled;
	expect(session.claudeSessionId).toBe("original-native-id");
	expect(session.actions.find((entry) => entry.kind === "review")?.snapshot).toBe(snapshot.snapshot);
	expect(await readFile(join(cwd, "base.ts"), "utf8")).toContain("current");
});

it("uses native Codex OAuth and preserves unrelated metadata on token refresh", async () => {
	const cwd = await repository();
	const access = `header.${Buffer.from(JSON.stringify({ exp: 2000000000 })).toString("base64url")}.signature`;
	await writeFile(
		join(cwd, "auth.json"),
		JSON.stringify({
			auth_mode: "chatgpt",
			opaque: { preserved: true },
			tokens: { access_token: access, refresh_token: "old", account_id: "test", id_token: "keep" },
		}),
	);
	const auth = new CodexAuthStorage(cwd);
	expect(await auth.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
	await auth.modify("openai-codex", async (current) => {
		expect(current?.type).toBe("oauth");
		return { type: "oauth", access, refresh: "new", expires: 2000000000000, accountId: "test" };
	});
	const data = JSON.parse(await readFile(join(cwd, "auth.json"), "utf8"));
	expect(data.opaque).toEqual({ preserved: true });
	expect(data.tokens.refresh_token).toBe("new");
	expect(data.tokens.id_token).toBe("keep");
	await expect(auth.delete()).rejects.toThrow("cannot log out");
});
