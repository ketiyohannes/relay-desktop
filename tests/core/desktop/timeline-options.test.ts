import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { DesktopTimeline } from "../../../src/core/desktop/timeline.ts";
import { fakeAccountCatalog } from "./fixtures.ts";
import { type DesktopEngine, DesktopRuntime } from "./offline-runtime.ts";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(git = true, engine?: DesktopEngine) {
	const project = await mkdtemp(join(tmpdir(), "relay-timeline-options-"));
	const data = await mkdtemp(join(tmpdir(), "relay-timeline-data-"));
	directories.push(project, data);
	if (git) await execute("git", ["init", "-q", project]);
	await writeFile(join(project, "file.ts"), "before\n");
	let started = false;
	let finish!: () => void;
	const settled = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const runtime = new DesktopRuntime(
		data,
		{
			state: (state) => {
				if (state.busySession) started = true;
				else if (started) finish();
			},
			permission: async () => true,
		},
		engine ??
			(async (_session, _account, _prompt, _abort, callbacks) => {
				await callbacks.checkpoint("Before edit");
				await writeFile(join(project, "file.ts"), "after\n");
				await callbacks.checkpoint("After edit");
				await callbacks.text("reply", "Done", true);
			}),
		fakeAccountCatalog,
		[],
	);
	await runtime.initialize();
	await runtime.command({ type: "project", path: project });
	await runtime.command({
		type: "account",
		account: { id: "", name: "test", engine: "claude", configDir: "", provider: "", model: "" },
	});
	await runtime.command({ type: "session", project });
	const session = runtime.store.state.sessions[0];
	return { runtime, session, project, data, settled };
}

it.each([true, false])("keeps timeline optional while prompts and file editing work (Git: %s)", async (git) => {
	const { runtime, session, project, settled } = await setup(git);
	expect(await runtime.command({ type: "timeline_status", sessionId: session.id })).toEqual({
		timeline: { supported: git, enabled: false },
	});
	const history = await runtime.command({ type: "history", sessionId: session.id });
	expect(history).toEqual({
		groups: [],
		truncated: false,
		message: git ? "Import timeline to view project history." : "Timeline is not supported for this project.",
	});
	await runtime.command({ type: "prompt", sessionId: session.id, text: "Edit" });
	await settled;
	expect(session.actions.map((action) => action.kind)).toEqual(["user", "assistant"]);
	await runtime.command({
		type: "editor_save",
		sessionId: session.id,
		path: "file.ts",
		expected: "after\n",
		content: "manual\n",
	});
	expect(await readFile(join(project, "file.ts"), "utf8")).toBe("manual\n");
	expect(session.actions).toHaveLength(2);
	if (git) expect((await execute("git", ["for-each-ref", "refs/relay-timeline/"], { cwd: project })).stdout).toBe("");
});

it("imports only the selected native session's history, persists it and captures future changes", async () => {
	const { runtime, session, project, data, settled } = await setup();
	session.importedFrom = { provider: "codex", sessionId: "existing", path: "unused", importedAt: Date.now() };
	const native = new DesktopTimeline(project, "existing");
	await native.checkpoint("Baseline");
	await writeFile(join(project, "file.ts"), "native edit\n");
	const recorded = await native.checkpoint("Native edit");
	await execute("git", ["update-ref", "refs/codex-timeline/existing", recorded.snapshot], { cwd: project });
	const other = new DesktopTimeline(project, "another-session");
	await other.checkpoint("Session baseline");
	await writeFile(join(project, "other.ts"), "another session\n");
	const unrelated = await other.checkpoint("Unrelated edit");
	await execute("git", ["update-ref", "refs/codex-timeline/existing-extra", unrelated.snapshot], { cwd: project });
	expect(await runtime.command({ type: "timeline_enable", sessionId: session.id, enabled: true })).toEqual({
		timeline: { supported: true, enabled: true },
	});
	const history = await runtime.command({ type: "history", sessionId: session.id });
	if (!("groups" in history)) throw new Error("Expected history");
	expect(history.groups.flatMap((group) => group.events).some((event) => event.snapshot === recorded.snapshot)).toBe(
		true,
	);
	expect(session.actions.map((action) => action.snapshot)).toEqual([recorded.snapshot]);
	expect(session.actions[0].files).toEqual(["file.ts"]);
	expect(session.actions.some((action) => action.snapshot === unrelated.snapshot)).toBe(false);
	await runtime.command({ type: "timeline_enable", sessionId: session.id, enabled: true });
	expect(session.actions).toHaveLength(1);
	const loaded = new DesktopRuntime(
		data,
		{ state: () => {}, permission: async () => false },
		undefined,
		fakeAccountCatalog,
		[],
	);
	await loaded.initialize();
	expect(await loaded.command({ type: "timeline_status", sessionId: session.id })).toEqual({
		timeline: { supported: true, enabled: true },
	});
	expect(loaded.store.session(session.id).actions[0].snapshot).toBe(recorded.snapshot);
	await runtime.command({ type: "prompt", sessionId: session.id, text: "Edit" });
	await settled;
	expect(session.actions.some((action) => action.kind === "checkpoint" && action.files?.includes("file.ts"))).toBe(
		true,
	);
	const ref = (await execute("git", ["rev-parse", `refs/relay-timeline/${session.id}`], { cwd: project })).stdout;
	await runtime.command({ type: "timeline_enable", sessionId: session.id, enabled: false });
	await runtime.command({
		type: "editor_save",
		sessionId: session.id,
		path: "file.ts",
		expected: "after\n",
		content: "disabled\n",
	});
	expect((await execute("git", ["rev-parse", `refs/relay-timeline/${session.id}`], { cwd: project })).stdout).toBe(ref);
});

it("keeps import and capture settings separate for sessions sharing a project", async () => {
	const { runtime, session, project } = await setup();
	await runtime.command({ type: "timeline_enable", sessionId: session.id, enabled: true });
	await runtime.command({ type: "session", project });
	const other = runtime.store.state.sessions[1];
	expect(await runtime.command({ type: "timeline_status", sessionId: other.id })).toEqual({
		timeline: { supported: true, enabled: false },
	});
	await runtime.command({ type: "timeline_enable", sessionId: other.id, enabled: true });
	await runtime.command({ type: "timeline_enable", sessionId: session.id, enabled: false });
	expect(await runtime.command({ type: "timeline_status", sessionId: other.id })).toEqual({
		timeline: { supported: true, enabled: true },
	});
});

it("imports a session's saved Relay checkpoints without changing Git or duplicating existing entries", async () => {
	const { runtime, session, project } = await setup();
	const timeline = new DesktopTimeline(project, session.id);
	await timeline.checkpoint("Session baseline");
	await writeFile(join(project, "file.ts"), "first edit\n");
	const first = await timeline.checkpoint("First edit");
	await writeFile(join(project, "file.ts"), "second edit\n");
	const second = await timeline.checkpoint("Second edit");
	session.actions.push({
		id: "saved-review",
		time: Date.now(),
		kind: "review",
		text: "Review first edit",
		snapshot: first.snapshot,
	});
	session.actions.push({
		id: "saved-checkpoint",
		time: Date.now(),
		kind: "checkpoint",
		text: "Second edit",
		...second,
	});
	const before = (await execute("git", ["status", "--porcelain=v1"], { cwd: project })).stdout;
	await runtime.command({ type: "timeline_enable", sessionId: session.id, enabled: true });
	const checkpoints = session.actions.filter((action) => action.kind === "checkpoint");
	expect(checkpoints.map((action) => action.snapshot)).toEqual([first.snapshot, second.snapshot]);
	expect(checkpoints[1].id).toBe("saved-checkpoint");
	expect(session.actions.some((action) => action.id === "saved-review")).toBe(true);
	expect((await execute("git", ["status", "--porcelain=v1"], { cwd: project })).stdout).toBe(before);
	expect((await execute("git", ["rev-parse", timeline.ref], { cwd: project })).stdout.trim()).toBe(second.snapshot);
});

it("does not assign unrelated refs or repository commits to a session with no recorded snapshots", async () => {
	const { runtime, session, project } = await setup();
	await execute("git", ["add", "--", "file.ts"], { cwd: project });
	await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "Unrelated commit"], {
		cwd: project,
	});
	const other = new DesktopTimeline(project, "unrelated");
	await other.checkpoint("Session baseline");
	await writeFile(join(project, "file.ts"), "another session\n");
	await other.checkpoint("Unrelated edit");
	await runtime.command({ type: "timeline_enable", sessionId: session.id, enabled: true });
	expect(session.actions).toEqual([]);
	const projectHistory = await runtime.command({ type: "history", sessionId: session.id });
	if (!("groups" in projectHistory)) throw new Error("Expected project history");
	expect(projectHistory.groups[0].text).toContain("Unrelated commit");
	expect(projectHistory.groups.flatMap((group) => group.events).some((event) => event.text === "Unrelated edit")).toBe(
		true,
	);
});

it("preserves existing opt-ins on load without enabling new sessions in the same project", async () => {
	const { runtime, session, project, data } = await setup();
	runtime.store.state.timelineProjects = [session.project];
	await runtime.store.save();
	const loaded = new DesktopRuntime(
		data,
		{ state: () => {}, permission: async () => false },
		undefined,
		fakeAccountCatalog,
		[],
	);
	await loaded.initialize();
	expect(loaded.store.session(session.id).timelineEnabled).toBe(true);
	expect(loaded.store.state.timelineProjects).toBeUndefined();
	await loaded.command({ type: "session", project });
	expect(loaded.store.state.sessions[1].timelineEnabled).toBeUndefined();
});

it("handles unsupported and missing folders without exposing Git errors or enabling capture", async () => {
	const { runtime, session } = await setup(false);
	expect(await runtime.command({ type: "timeline_enable", sessionId: session.id, enabled: true })).toEqual({
		timeline: { supported: false, enabled: false },
	});
	session.project = join(session.project, "missing");
	expect(await runtime.command({ type: "timeline_status", sessionId: session.id })).toEqual({
		timeline: { supported: false, enabled: false },
	});
	expect(await new DesktopTimeline("", "unlinked").supported()).toBe(false);
});

it("isolates capture failures from chat and hides old timeline errors without deleting them", async () => {
	const { runtime, session, project, settled } = await setup();
	await runtime.command({ type: "timeline_enable", sessionId: session.id, enabled: true });
	await rm(join(project, ".git"), { recursive: true });
	const error = runtime.store.append(session, {
		kind: "error",
		text: "Timeline unavailable: fatal: not a git repository",
	});
	await runtime.command({ type: "prompt", sessionId: session.id, text: "Edit" });
	await settled;
	expect(session.actions.filter((action) => action.kind === "error")).toEqual([error]);
	expect(session.actions.some((action) => action.kind === "assistant" && action.text === "Done")).toBe(true);
	const state = await runtime.command({ type: "state" });
	if (!("sessions" in state)) throw new Error("Expected state");
	expect(state.timelineAvailability?.[session.project]).toBe(false);
	expect(state.sessions[0].actions.find((action) => action.id === error.id)?.displayText).toBe("");
	expect(error.text).toContain("fatal:");
});
