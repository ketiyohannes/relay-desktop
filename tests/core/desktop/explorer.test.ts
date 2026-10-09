import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { projectHistory } from "../../../src/core/desktop/history.ts";
import { searchCode } from "../../../src/core/desktop/search.ts";
import { DesktopTimeline } from "../../../src/core/desktop/timeline.ts";
import { editorFile, saveEditorFile, workspaceView } from "../../../src/core/desktop/workspace.ts";
import { DesktopRuntime } from "./offline-runtime.ts";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function repository(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "relay-explorer-"));
	directories.push(cwd);
	await execute("git", ["init", "-q", cwd]);
	await execute("git", ["config", "user.name", "Test"], { cwd });
	await execute("git", ["config", "user.email", "test@local"], { cwd });
	await mkdir(join(cwd, "src"));
	await writeFile(join(cwd, "src/app.ts"), 'const message = "before";\nconst stable = true;\n');
	await execute("git", ["add", "--", "src/app.ts"], { cwd });
	await execute("git", ["commit", "-qm", "Initial code"], { cwd });
	return cwd;
}

it("groups recorded edits under a matching Git commit and keeps later events under WIP", async () => {
	const cwd = await repository();
	const timeline = new DesktopTimeline(cwd, "history");
	await timeline.checkpoint("Session baseline");
	await writeFile(join(cwd, "src/app.ts"), 'const message = "first";\n');
	const first = await timeline.checkpoint("First edit");
	await writeFile(join(cwd, "src/app.ts"), 'const message = "second";\n');
	const second = await timeline.checkpoint("Second edit");
	await execute("git", ["add", "--", "src/app.ts"], { cwd });
	await execute("git", ["commit", "-qm", "Update message"], { cwd });
	await writeFile(join(cwd, "src/app.ts"), 'const message = "third";\n');
	const third = await timeline.checkpoint("Third edit");
	// Existing npm/Neovim refs are read without migration or duplication.
	await execute("git", ["update-ref", "refs/codex-timeline/session-project", third.snapshot], { cwd });
	const before = (await execute("git", ["status", "--porcelain=v1"], { cwd })).stdout;
	const result = await projectHistory(timeline);
	expect(result.groups.map((group) => group.text)).toEqual([
		"#1 · Initial code",
		"#2 · Update message",
		"Uncommitted changes",
	]);
	expect(result.groups[1].events.map((event) => event.snapshot)).toEqual([first.snapshot, second.snapshot]);
	expect(result.groups[1].events.map((event) => event.changeOrder)).toEqual([1, 2]);
	expect(result.groups[2].events.map((event) => event.snapshot)).toEqual([third.snapshot]);
	expect((await execute("git", ["status", "--porcelain=v1"], { cwd })).stdout).toBe(before);
	const root = result.groups[0].action!;
	expect((await timeline.view(root.snapshot!, undefined, "src/app.ts", root.rootCommit)).diff).toContain(
		'+const message = "before"',
	);
});

it("preserves additions later removed and reads them through historical search", async () => {
	const cwd = await repository();
	const timeline = new DesktopTimeline(cwd, "removed");
	await timeline.checkpoint("Session baseline");
	await writeFile(join(cwd, "temporary.ts"), "const vanished = true;\n");
	const added = await timeline.checkpoint("Created file");
	await rm(join(cwd, "temporary.ts"));
	const deleted = await timeline.checkpoint("Removed file");
	const list = await timeline.view(deleted.snapshot, added.snapshot);
	const results = await searchCode(
		list,
		(path) => timeline.view(deleted.snapshot, added.snapshot, path),
		"VANISHED",
		"diff",
	);
	expect(results.matches).toEqual([
		{ path: "temporary.ts", line: 1, side: "before", text: "const vanished = true;", kind: "removed" },
	]);
});

it("searches only changed lines for diff scope and complete source for code scope", async () => {
	const cwd = await repository();
	await writeFile(join(cwd, "src/app.ts"), 'const message = "after";\nconst stable = true;\n');
	await mkdir(join(cwd, "node_modules"));
	await writeFile(join(cwd, "node_modules/noise.ts"), "const stable = true;\n");
	const view = await workspaceView(cwd);
	const load = (path: string) => workspaceView(cwd, path);
	expect((await searchCode(view, load, "stable", "diff")).matches).toEqual([]);
	expect((await searchCode(view, load, "stable", "code", "src/app.ts")).matches[0]).toMatchObject({
		line: 2,
		kind: "context",
	});
	expect((await searchCode(view, load, "message", "diff")).matches.map((match) => match.side)).toEqual([
		"before",
		"after",
	]);
	expect((await searchCode(view, load, "stable", "diff", "node_modules/noise.ts")).matches).toEqual([]);
});

it("reports bounded search and skips binary and unreadable files", async () => {
	const view = { files: ["binary", "missing", "many"], changed: ["binary", "missing", "many"] };
	const result = await searchCode(
		view,
		async (path) => {
			if (path === "missing") throw new Error("unavailable");
			return { ...view, path, after: path === "binary" ? "\0" : Array(250).fill("match").join("\n") };
		},
		"match",
		"diff",
	);
	expect(result.matches).toHaveLength(200);
	expect(result.truncated).toBe(true);
	expect(result.skipped).toBe(2);
});

it("saves working text with permissions and rejects a stale editor draft", async () => {
	const cwd = await repository();
	await chmod(join(cwd, "src/app.ts"), 0o755);
	const loaded = await editorFile(cwd, "src/app.ts");
	const staged = (await execute("git", ["diff", "--cached"], { cwd })).stdout;
	await saveEditorFile(cwd, loaded.path, loaded.content, "const updated = 1;\n");
	expect(await readFile(join(cwd, loaded.path), "utf8")).toBe("const updated = 1;\n");
	expect((await stat(join(cwd, loaded.path))).mode & 0o777).toBe(0o755);
	await expect(saveEditorFile(cwd, loaded.path, loaded.content, "stale")).rejects.toThrow("changed on disk");
	expect((await execute("git", ["diff", "--cached"], { cwd })).stdout).toBe(staged);
});

it("rejects editor traversal, symbolic links, hard links, binary and invalid UTF-8 files", async () => {
	const cwd = await repository();
	const outside = await repository();
	await symlink(join(outside, "src/app.ts"), join(cwd, "escape.ts"));
	await symlink(join(cwd, "src/app.ts"), join(cwd, "alias.ts"));
	await link(join(cwd, "src/app.ts"), join(cwd, "hard.ts"));
	await expect(editorFile(cwd, "escape.ts")).rejects.toThrow("outside the project");
	await expect(editorFile(cwd, "alias.ts")).rejects.toThrow("link");
	await expect(editorFile(cwd, "hard.ts")).rejects.toThrow("link");
	await expect(editorFile(cwd, join(outside, "src/app.ts"))).rejects.toThrow("outside the project");
	await writeFile(join(cwd, "binary"), "\0");
	await expect(editorFile(cwd, "binary")).rejects.toThrow("Binary");
	await writeFile(join(cwd, "invalid"), Buffer.from([0xff, 0xfe]));
	await expect(editorFile(cwd, "invalid")).rejects.toThrow();
});

it("records manual editor saves and lets the runtime inspect Git commits without changing the session ledger", async () => {
	const cwd = await repository();
	const runtime = new DesktopRuntime(join(cwd, ".git/relay"), { state: () => {}, permission: async () => false });
	await runtime.initialize();
	await runtime.command({ type: "project", path: cwd });
	await runtime.command({ type: "session", project: cwd });
	const session = runtime.store.state.sessions[0];
	await runtime.command({ type: "timeline_enable", sessionId: session.id, enabled: true });
	const loaded = await runtime.command({ type: "editor_read", sessionId: session.id, path: "src/app.ts" });
	if (!("content" in loaded)) throw new Error("Expected editor file");
	await runtime.command({
		type: "editor_save",
		sessionId: session.id,
		path: loaded.path,
		expected: loaded.content,
		content: "const manual = true;\n",
	});
	expect(session.actions.at(-1)?.text).toBe("Manual edit · src/app.ts");
	expect(session.actions.at(-1)?.files).toEqual(["src/app.ts"]);
	const history = await runtime.command({ type: "history", sessionId: session.id });
	if (!("groups" in history)) throw new Error("Expected history");
	const actionId = history.groups[0].action!.id;
	const count = session.actions.length;
	const view = await runtime.command({ type: "snapshot", sessionId: session.id, actionId, path: "src/app.ts" });
	if (!("after" in view)) throw new Error("Expected snapshot");
	expect(view.after).toContain('"before"');
	expect(session.actions).toHaveLength(count);
	const results = await runtime.command({
		type: "search_code",
		sessionId: session.id,
		actionId,
		query: "message",
		scope: "diff",
	});
	if (!("matches" in results)) throw new Error("Expected search");
	expect(results.matches[0].side).toBe("after");
	await expect(
		runtime.command({ type: "snapshot", sessionId: session.id, actionId: "history:garbage" }),
	).rejects.toThrow("No snapshot");
});

it("supports an unborn Git repository in history and manual editing", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "relay-unborn-explorer-"));
	directories.push(cwd);
	await execute("git", ["init", "-q", cwd]);
	expect((await projectHistory(new DesktopTimeline(cwd, "unborn"))).groups.map((group) => group.id)).toEqual(["wip"]);
	await writeFile(join(cwd, "new.ts"), "first\n");
	await saveEditorFile(cwd, "new.ts", "first\n", "second\n");
	expect(await readFile(join(cwd, "new.ts"), "utf8")).toBe("second\n");
});
