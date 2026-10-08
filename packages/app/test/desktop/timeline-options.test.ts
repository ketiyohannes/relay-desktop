import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { DesktopTimeline } from "../../src/desktop/timeline.ts";
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

it("imports existing history only on opt-in, persists the choice and captures future changes", async () => {
	const { runtime, session, project, data, settled } = await setup();
	const native = new DesktopTimeline(project, "existing");
	await native.checkpoint("Baseline");
	await writeFile(join(project, "file.ts"), "native edit\n");
	const recorded = await native.checkpoint("Native edit");
	await execute("git", ["update-ref", "refs/codex-timeline/existing", recorded.snapshot], { cwd: project });
	expect(await runtime.command({ type: "timeline_enable", sessionId: session.id, enabled: true })).toEqual({
		timeline: { supported: true, enabled: true },
	});
	const history = await runtime.command({ type: "history", sessionId: session.id });
	if (!("groups" in history)) throw new Error("Expected history");
	expect(history.groups.flatMap((group) => group.events).some((event) => event.snapshot === recorded.snapshot)).toBe(
		true,
	);
	expect(session.actions).toEqual([]);
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
	expect((await execute("git", ["rev-parse", `refs/relay-timeline/${session.id}`], { cwd: project })).stdout).toBe(
		ref,
	);
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
