import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Handoff } from "../../../src/core/contracts.ts";
import { publicHistory } from "../../../src/core/desktop/engines.ts";
import { DesktopSessionImporter, sessionChatText } from "../../../src/core/desktop/session-import.ts";
import { DesktopStore } from "../../../src/core/desktop/store.ts";
import { turnText } from "../../../src/core/handoffs/context.ts";
import { fakeAccountCatalog } from "./fixtures.ts";
import { DesktopRuntime } from "./offline-runtime.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(provider: "codex" | "claude", entries: Record<string, unknown>[] = []) {
	const root = await mkdtemp(join(tmpdir(), "relay-import-test-"));
	roots.push(root);
	const sessionId = randomUUID();
	const project = join(root, "project");
	await mkdir(project);
	const path = join(root, `${sessionId}.jsonl`);
	const records =
		provider === "codex"
			? [{ type: "session_meta", payload: { id: sessionId, cwd: project } }, ...entries]
			: entries.map((entry) => ({ sessionId, cwd: project, ...entry }));
	await writeFile(path, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return { root, project, path, sessionId };
}
const response = (payload: Record<string, unknown>) => ({
	type: "response_item",
	timestamp: "2026-10-07T09:00:00Z",
	payload,
});
const user = (text: string) => response({ type: "message", role: "user", content: [{ type: "input_text", text }] });

it("shows only the user request from handoffs and hides account-switch continuation prompts", async () => {
	const handoff: Handoff = {
		version: 1,
		id: "handoff",
		through: 1,
		objective: "Build",
		constraints: [],
		conversation: [],
		decisions: [],
		unresolved: [],
		completedOutcomes: [],
		artifacts: [],
		workspace: "/project",
		tasks: [],
		omittedEvents: 0,
	};
	const prompt = "Explain this marker:\n\nCurrent user request:\nKeep all of this text";
	const wrapped = turnText(prompt, handoff);
	expect(sessionChatText(wrapped)).toBe(prompt);
	expect(sessionChatText(wrapped.replace('"version":1', '"version":2'))).toBe(
		wrapped.replace('"version":1', '"version":2'),
	);
	for (const from of ["Relay", "the Relay"])
		expect(
			sessionChatText(
				`Continue the interrupted request from ${from} history. Inspect current files and completed tool results first. Do not replay completed commands or edits.`,
			),
		).toBe("");
	const file = await fixture("codex", [user(wrapped)]);
	const runtime = new DesktopRuntime(
		join(file.root, "relay"),
		{ state: () => {}, permission: async () => true },
		async () => {},
		fakeAccountCatalog,
		[{ provider: "codex", path: file.root }],
	);
	await runtime.initialize();
	await runtime.refreshSessions();
	const listing = await runtime.command({ type: "state" });
	if (!("sessions" in listing)) throw new Error("Expected state");
	const id = listing.sessions[0].id;
	await runtime.command({ type: "session_load", sessionId: id });
	const session = runtime.store.session(id);
	// Old releases could persist an unfiltered displayText as well as the raw source.
	session.actions[0].displayText = wrapped;
	const view = await runtime.command({ type: "state" });
	if (!("sessions" in view)) throw new Error("Expected state");
	expect(view.sessions[0].actions[0]).toMatchObject({ text: wrapped, displayText: prompt });
	expect(session.actions[0].text).toBe(wrapped);
	expect(publicHistory(session).messages[0].text).toBe(prompt);
});

it("includes saved native account profiles in automatic discovery without scanning Pi auth directories", async () => {
	const file = await fixture("codex", [user("Custom profile")]);
	const importer = new DesktopSessionImporter();
	const listing = await importer.list("codex", file.root);
	const spy = vi
		.spyOn(DesktopSessionImporter.prototype, "list")
		.mockImplementation(async (_provider, path) =>
			path === file.root ? listing : { path: path || "default", items: [], warnings: [] },
		);
	try {
		const runtime = new DesktopRuntime(
			join(file.root, "relay"),
			{ state: () => {}, permission: async () => true },
			async () => {},
			fakeAccountCatalog,
		);
		await runtime.initialize();
		runtime.store.state.accounts = [
			{
				id: "c",
				name: "Codex",
				engine: "pi",
				credentialSource: "codex",
				configDir: file.root,
				provider: "openai-codex",
				model: "test",
			},
			{ id: "a", name: "Claude", engine: "claude", configDir: file.project, provider: "", model: "sonnet" },
			{
				id: "p",
				name: "Pi",
				engine: "pi",
				configDir: join(file.root, "pi"),
				provider: "openai-codex",
				model: "test",
			},
		];
		const result = await runtime.command({ type: "refresh_sessions" });
		if (!("sessions" in result)) throw new Error("Expected state");
		expect(result.sessions).toHaveLength(1);
		expect(spy).toHaveBeenCalledWith("codex", undefined);
		expect(spy).toHaveBeenCalledWith("claude", undefined);
		expect(spy).toHaveBeenCalledWith("codex", file.root);
		expect(spy).toHaveBeenCalledWith("claude", file.project);
		expect(spy).not.toHaveBeenCalledWith("codex", join(file.root, "pi"));
	} finally {
		spy.mockRestore();
	}
});

it("keeps failed loads retryable and allows reading conversations with no recorded project", async () => {
	const file = await fixture("codex", [user("No folder")]);
	const original = (await readFile(file.path, "utf8")).replace(JSON.stringify(file.project), '""');
	await writeFile(file.path, original);
	const runtime = new DesktopRuntime(
		join(file.root, "relay"),
		{ state: () => {}, permission: async () => true },
		async () => {},
		fakeAccountCatalog,
		[{ provider: "codex", path: file.root }],
	);
	await runtime.initialize();
	await runtime.refreshSessions();
	const state = await runtime.command({ type: "state" });
	if (!("sessions" in state)) throw new Error("Expected state");
	const sessionId = state.sessions[0].id;
	await writeFile(file.path, `${original}invalid\n`);
	await expect(runtime.command({ type: "session_load", sessionId })).rejects.toThrow("Invalid session JSON");
	expect(runtime.store.state.sessions).toHaveLength(0);
	await writeFile(file.path, original);
	await runtime.command({ type: "session_load", sessionId });
	expect(runtime.store.session(sessionId).project).toBe("");
	expect(runtime.store.session(sessionId).actions[0].text).toBe("No folder");
	await expect(runtime.command({ type: "prompt", sessionId, text: "Continue" })).rejects.toThrow("Link folder");
});

it("discovers both providers without copying histories, deduplicates roots, and opens sessions lazily", async () => {
	const codex = await fixture("codex", [user("Automatic Codex")]);
	const claude = await fixture("claude", [
		{ type: "user", uuid: randomUUID(), parentUuid: null, message: { role: "user", content: "Automatic Claude" } },
	]);
	const directory = join(codex.root, "relay");
	const runtime = new DesktopRuntime(
		directory,
		{ state: () => {}, permission: async () => true },
		async () => {},
		fakeAccountCatalog,
		[
			{ provider: "codex", path: codex.root },
			{ provider: "codex", path: codex.path },
			{ provider: "claude", path: claude.root },
			{ provider: "claude", path: join(codex.root, "missing") },
		],
	);
	await runtime.initialize();
	const discovered = await runtime.command({ type: "refresh_sessions" });
	if (!("sessions" in discovered)) throw new Error("Expected state");
	expect(discovered.sessions).toHaveLength(2);
	expect(discovered.projects).toEqual(expect.arrayContaining([codex.project, claude.project]));
	expect(discovered.sessions.every((session) => session.externalSource && !session.actions.length)).toBe(true);
	expect(runtime.store.state.sessions).toHaveLength(0);
	const sessionId = discovered.sessions.find((s) => s.importedFrom?.provider === "codex")!.id;
	await Promise.all([
		runtime.command({ type: "session_load", sessionId }),
		runtime.command({ type: "session_load", sessionId }),
	]);
	expect(runtime.store.state.sessions).toHaveLength(1);
	expect(runtime.store.session(sessionId).actions[0].text).toBe("Automatic Codex");
	expect(runtime.store.session(sessionId).externalSource).toBeUndefined();
	const persisted = new DesktopStore(directory);
	await persisted.load();
	expect(persisted.state.sessions).toHaveLength(1);
});

it("refreshes new and removed sources without overwriting Relay continuations", async () => {
	const file = await fixture("codex", [user("Original")]);
	const directory = join(file.root, "relay");
	const discoveryRoots = [{ provider: "codex" as const, path: file.root }];
	const runtime = new DesktopRuntime(
		directory,
		{ state: () => {}, permission: async () => true },
		async () => {},
		fakeAccountCatalog,
		discoveryRoots,
	);
	await runtime.initialize();
	await runtime.refreshSessions();
	const state = await runtime.command({ type: "state" });
	if (!("sessions" in state)) throw new Error("Expected state");
	const id = state.sessions[0].id;
	await runtime.command({ type: "session_load", sessionId: id });
	runtime.store.append(runtime.store.session(id), { kind: "assistant", text: "Relay continuation" });
	await runtime.store.save();
	const original = await readFile(file.path, "utf8");
	await writeFile(file.path, `${original}${JSON.stringify(user("Later native message"))}\n`);
	const newPath = join(file.root, "new.jsonl");
	await writeFile(
		newPath,
		`${JSON.stringify({ type: "session_meta", payload: { id: randomUUID(), cwd: file.project } })}\n${JSON.stringify(user("New session"))}\n`,
	);
	const next = await runtime.command({ type: "refresh_sessions" });
	if (!("sessions" in next)) throw new Error("Expected state");
	expect(next.sessions).toHaveLength(2);
	expect(next.sessions.find((s) => s.id === id)?.actions.map((a) => a.text)).toContain("Relay continuation");
	expect(next.sessions.find((s) => s.id === id)?.actions.map((a) => a.text)).not.toContain("Later native message");
	await rm(newPath);
	await rm(file.path);
	const after = await runtime.command({ type: "refresh_sessions" });
	if (!("sessions" in after)) throw new Error("Expected state");
	expect(after.sessions.map((s) => s.id)).toEqual([id]);
	const restarted = new DesktopRuntime(
		directory,
		{ state: () => {}, permission: async () => true },
		async () => {},
		fakeAccountCatalog,
		discoveryRoots,
	);
	await restarted.initialize();
	await restarted.refreshSessions();
	expect(restarted.store.session(id).actions.at(-1)?.text).toBe("Relay continuation");
});

it("loads history before direct provider selection and prompting, and reports unreadable sessions", async () => {
	const file = await fixture("codex", [user("Shared source history")]);
	let context = "";
	const runtime = new DesktopRuntime(
		join(file.root, "relay"),
		{ state: () => {}, permission: async () => true },
		async (session) => {
			context = JSON.stringify(publicHistory(session));
		},
		fakeAccountCatalog,
		[{ provider: "codex", path: file.root }],
	);
	await runtime.initialize();
	await runtime.refreshSessions();
	const state = await runtime.command({ type: "state" });
	if (!("sessions" in state)) throw new Error("Expected state");
	await runtime.command({
		type: "account",
		account: {
			id: "",
			name: "Claude",
			engine: "claude",
			configDir: "",
			provider: "",
			model: "sonnet",
		},
	});
	const sessionId = state.sessions[0].id;
	await runtime.command({
		type: "select_account",
		sessionId,
		accountId: runtime.store.state.accounts[0].id,
		autoSwitch: true,
	});
	await runtime.command({ type: "prompt", sessionId, text: "Continue" });
	await expect.poll(() => runtime.store.state.busySession).toBeUndefined();
	expect(context).toContain("Shared source history");
	await writeFile(join(file.root, "invalid.jsonl"), "invalid\n");
	const result = await runtime.command({ type: "refresh_sessions" });
	if (!("sessions" in result)) throw new Error("Expected state");
	expect(result.sessionDiscovery?.warnings.join(" ")).toContain("invalid session files skipped");
});

it("imports Codex messages once, pairs tool results, retains unfinished tools, and excludes private reasoning", async () => {
	const file = await fixture("codex", [
		user("Fix it"),
		{ type: "event_msg", payload: { type: "user_message", message: "Fix it" } },
		response({ type: "reasoning", encrypted_content: "secret" }),
		response({ type: "function_call", call_id: "a", name: "exec_command", arguments: '{"cmd":"pwd"}' }),
		response({ type: "function_call_output", call_id: "a", output: "done" }),
		response({ type: "custom_tool_call", call_id: "b", name: "apply_patch", input: "patch" }),
		response({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Finished" }] }),
	]);
	const before = await readFile(file.path);
	const importer = new DesktopSessionImporter();
	const { items } = await importer.list("codex", file.root);
	expect(items).toHaveLength(1);
	const preview = await importer.preview(items[0].id);
	expect(preview.actions.map((action) => action.kind)).toEqual(["user", "tool", "tool", "assistant"]);
	expect(preview.actions[1]).toMatchObject({ status: "done", output: "done" });
	expect(preview.actions[2].status).toBe("error");
	expect(JSON.stringify(preview)).not.toContain("secret");
	expect(await readFile(file.path)).toEqual(before);
});

it("uses Claude SDK branch projection and preserves tool failures", async () => {
	const u = randomUUID(),
		a = randomUUID(),
		r = randomUUID(),
		end = randomUUID();
	const file = await fixture("claude", [
		{ type: "user", uuid: u, parentUuid: null, message: { role: "user", content: "Read the file" } },
		{
			type: "assistant",
			uuid: randomUUID(),
			parentUuid: u,
			message: { role: "assistant", content: [{ type: "text", text: "Abandoned branch" }] },
		},
		{
			type: "assistant",
			uuid: a,
			parentUuid: u,
			message: {
				role: "assistant",
				content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "x.ts" } }],
			},
		},
		{
			type: "user",
			uuid: r,
			parentUuid: a,
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "read", content: "Missing file", is_error: true }],
			},
		},
		{
			type: "assistant",
			uuid: end,
			parentUuid: r,
			message: { role: "assistant", content: [{ type: "text", text: "File missing" }] },
		},
	]);
	const importer = new DesktopSessionImporter();
	const { items } = await importer.list("claude", file.root);
	const preview = await importer.preview(items[0].id);
	expect(preview.actions.map((action) => action.kind)).toEqual(["user", "tool", "assistant"]);
	expect(preview.actions[1]).toMatchObject({ text: "Read", status: "error", output: "Missing file" });
	expect(JSON.stringify(preview)).not.toContain("Abandoned branch");
});

it("applies Codex rollback and imports legacy event-only transcripts", async () => {
	const file = await fixture("codex", [
		user("Keep"),
		user("Discard"),
		{ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
		user("Replacement"),
	]);
	const importer = new DesktopSessionImporter();
	const listing = await importer.list("codex", file.path);
	expect((await importer.preview(listing.items[0].id)).actions.map((a) => a.text)).toEqual(["Keep", "Replacement"]);
	const legacy = await fixture("codex", [
		{ type: "event_msg", payload: { type: "user_message", message: "Old prompt" } },
		{ type: "event_msg", payload: { type: "agent_message", message: "Old answer" } },
	]);
	const result = await importer.list("codex", legacy.path);
	expect((await importer.preview(result.items[0].id)).actions.map((a) => a.text)).toEqual(["Old prompt", "Old answer"]);
});

it("skips symlink discovery, refuses replaced symlink sources, and handles incomplete tails", async () => {
	const file = await fixture("codex", [user("Hello")]);
	await symlink(file.path, join(file.root, "linked.jsonl"));
	const importer = new DesktopSessionImporter();
	const listing = await importer.list("codex", file.root);
	expect(listing.items).toHaveLength(1);
	const original = await readFile(file.path, "utf8");
	await writeFile(file.path, `${original}{"type":`);
	expect((await importer.preview(listing.items[0].id)).warnings.join(" ")).toContain("unfinished last record");
	await writeFile(file.path, `${original}invalid\n`);
	await expect(importer.preview(listing.items[0].id)).rejects.toThrow("Invalid session JSON");
	await rm(file.path);
	await symlink(join(file.root, "linked.jsonl"), file.path);
	await expect(importer.preview(listing.items[0].id)).rejects.toThrow();
});

it("persists one imported session, permits viewing missing projects, relinks and continues across accounts", async () => {
	const file = await fixture("codex", [
		user("Remember the completed edit"),
		response({ type: "function_call", call_id: "write", name: "write", arguments: '{"path":"x.ts"}' }),
		response({ type: "function_call_output", call_id: "write", output: "written" }),
	]);
	await rm(file.project, { recursive: true });
	const directory = join(file.root, "relay");
	const contexts: string[] = [];
	const runtime = new DesktopRuntime(
		directory,
		{ state: () => {}, permission: async () => true },
		async (session, _account, _prompt, _abort, callbacks) => {
			contexts.push(JSON.stringify(publicHistory(session)));
			await callbacks.text("reply", "Continued", true);
		},
		fakeAccountCatalog,
	);
	await runtime.initialize();
	const result = await runtime.command({ type: "external_sessions", provider: "codex", path: file.path });
	if (!("items" in result)) throw new Error("Expected listing");
	const command = { type: "import_session", sourceId: result.items[0].id } as const;
	const first = await runtime.command(command);
	expect(await runtime.command(command)).toEqual(first);
	expect(runtime.store.state.sessions).toHaveLength(1);
	const session = runtime.store.state.sessions[0];
	await expect(runtime.command({ type: "prompt", sessionId: session.id, text: "Continue" })).rejects.toThrow(
		"Link folder",
	);
	await mkdir(file.project);
	await runtime.command({ type: "session_project", sessionId: session.id, project: file.project });
	await runtime.command({
		type: "account",
		account: { id: "", name: "Claude", engine: "claude", provider: "", model: "sonnet", configDir: "" },
	});
	await runtime.command({
		type: "select_account",
		sessionId: session.id,
		accountId: runtime.store.state.accounts[0].id,
		autoSwitch: true,
	});
	await runtime.command({ type: "prompt", sessionId: session.id, text: "Continue" });
	await expect.poll(() => runtime.store.state.busySession).toBeUndefined();
	expect(contexts[0]).toContain("Remember the completed edit");
	expect(contexts[0]).toContain("written");
	const store = new DesktopStore(directory);
	await store.load();
	expect(store.state.sessions[0].id).toBe(session.id);
	expect(store.state.sessions[0].importedFrom?.sessionId).toBe(file.sessionId);
});

it("uses real prompts instead of injected context and applies native title updates to cached sessions", async () => {
	const file = await fixture("codex", [
		user("# AGENTS.md instructions for /project\n<INSTRUCTIONS>Keep tools configurable.</INSTRUCTIONS>"),
		user("<environment_context>project metadata</environment_context>"),
		user("Fix the sidebar\n\nand format imported messages"),
	]);
	const importer = new DesktopSessionImporter();
	const initial = await importer.list("codex", file.root);
	expect(initial.items[0].name).toBe("Fix the sidebar and format imported messages");
	const preview = await importer.preview(initial.items[0].id);
	expect(preview.actions[0]).toMatchObject({ kind: "user", label: "Project instructions", provider: "Codex" });
	expect(preview.actions[1].label).toBe("Environment");
	expect(preview.actions[2].label).toBeUndefined();
	expect(preview.actions).toHaveLength(3);
	const titleIndex = join(file.root, "session_index.jsonl");
	await writeFile(titleIndex, `${JSON.stringify({ id: file.sessionId, thread_name: "Native session title" })}\n`);
	expect((await importer.list("codex", file.root)).items[0].name).toBe("Native session title");
	await writeFile(titleIndex, `${JSON.stringify({ id: file.sessionId, thread_name: "Renamed native session" })}\n`);
	expect((await importer.list("codex", file.path)).items[0].name).toBe("Renamed native session");
	expect((await importer.preview(initial.items[0].id)).source.name).toBe("Renamed native session");
});

it("reads late Claude titles with the SDK and preserves text/tool block ordering", async () => {
	const u = randomUUID(),
		a = randomUUID(),
		r = randomUUID();
	const file = await fixture("claude", [
		{ type: "user", uuid: u, parentUuid: null, message: { role: "user", content: "Inspect the file" } },
		{
			type: "assistant",
			uuid: a,
			parentUuid: u,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Before the tool" },
					{ type: "tool_use", id: "read", name: "Read", input: { file_path: "app.ts" } },
					{ type: "text", text: "After the tool" },
				],
			},
		},
		{
			type: "user",
			uuid: r,
			parentUuid: a,
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: "source" }] },
		},
		{ type: "progress", payload: "x".repeat(280 * 1024) },
		{ type: "custom-title", customTitle: "Claude native title" },
	]);
	const importer = new DesktopSessionImporter();
	const list = await importer.list("claude", file.root);
	expect(list.items[0].name).toBe("Claude native title");
	const preview = await importer.preview(list.items[0].id);
	expect(preview.actions.map((a) => a.text)).toEqual(["Inspect the file", "Before the tool", "Read", "After the tool"]);
	expect(preview.actions[2]).toMatchObject({ provider: "Claude", output: "source", status: "done" });
});

it("repairs already imported display titles and context labels without replacing the saved history", async () => {
	const file = await fixture("codex", [
		user("# AGENTS.md instructions for /project\nInstructions"),
		user("Actual request"),
	]);
	const runtime = new DesktopRuntime(
		join(file.root, "relay"),
		{ state: () => {}, permission: async () => true },
		async () => {},
		fakeAccountCatalog,
		[{ provider: "codex", path: file.root }],
	);
	await runtime.initialize();
	await runtime.refreshSessions();
	const state = await runtime.command({ type: "state" });
	if (!("sessions" in state)) throw new Error("Expected state");
	const sessionId = state.sessions[0].id;
	await runtime.command({ type: "session_load", sessionId });
	const session = runtime.store.session(sessionId);
	session.name = "# AGENTS.md instructions for /project";
	delete session.actions[0].label;
	delete session.actions[0].provider;
	runtime.store.append(session, { kind: "assistant", text: "Relay continuation", provider: "Claude" });
	const result = await runtime.command({ type: "state" });
	if (!("sessions" in result)) throw new Error("Expected state");
	expect(result.sessions[0].name).toBe("Actual request");
	expect(result.sessions[0].actions[0]).toMatchObject({ label: "Project instructions", provider: "Codex" });
	expect(result.sessions[0].actions.at(-1)).toMatchObject({ text: "Relay continuation", provider: "Claude" });
	expect(session.name).toBe("# AGENTS.md instructions for /project");
	expect(session.actions.at(-1)?.text).toBe("Relay continuation");
});

it("excludes internal Codex reviews and spawned workers from automatic and explicit discovery", async () => {
	const file = await fixture("codex", [user("Real chat")]);
	for (const [name, meta] of Object.entries({
		guardian: { thread_source: "guardian_review", source: { subagent: { other: "guardian" } } },
		worker: { source: { subagent: { thread_spawn: { parent_thread_id: file.sessionId } } } },
	})) {
		await writeFile(
			join(file.root, `${name}.jsonl`),
			`${JSON.stringify({ type: "session_meta", payload: { id: randomUUID(), cwd: file.project, ...meta } })}\n${JSON.stringify(user("Internal transcript"))}\n`,
		);
	}
	const importer = new DesktopSessionImporter();
	const result = await importer.list("codex", file.root);
	expect(result.items.map((item) => item.name)).toEqual(["Real chat"]);
	expect(result.warnings).toEqual([]);
	expect((await importer.list("codex", join(file.root, "guardian.jsonl"))).items).toEqual([]);
});

it("projects normal chat text without injected context while retaining real prompts, XML examples, and user answers", () => {
	expect(
		sessionChatText(
			"# AGENTS.md instructions for /project\n<INSTRUCTIONS>Rules</INSTRUCTIONS>\n<environment_context>cwd</environment_context>\nFix the sidebar",
		),
	).toBe("Fix the sidebar");
	expect(
		sessionChatText(
			"<system-reminder>Internal reminder</system-reminder>\nPlease read the file\n<environment_context>cwd</environment_context>",
		),
	).toBe("Please read the file");
	expect(
		sessionChatText(
			"Another language model started to solve this problem and produced a summary of its thinking process.\nInternal handoff",
		),
	).toBe("");
	const example = "Explain this XML:\n```xml\n<system-reminder>Example</system-reminder>\n```";
	expect(sessionChatText(`${example}\n<system-reminder>Internal</system-reminder>`)).toBe(example);
	expect(
		sessionChatText(
			'<send_user_message_question_reply>\n[{"answer":"Use Codex","question":"Which provider?","questionItemId":"internal-id"}]\n</send_user_message_question_reply>',
		),
	).toBe("Use Codex");
	expect(sessionChatText('{"outcome":"allow"}')).toBe('{"outcome":"allow"}');
});

it("preserves native message channels but excludes analysis from visible imported chats", async () => {
	const file = await fixture("codex", [
		user("Fix the sidebar"),
		response({
			type: "message",
			role: "assistant",
			channel: "analysis",
			content: [{ type: "output_text", text: "Private planning" }],
		}),
		response({
			type: "message",
			role: "assistant",
			channel: "commentary",
			content: [{ type: "output_text", text: "Checking the sidebar." }],
		}),
		response({
			type: "message",
			role: "assistant",
			channel: "final",
			content: [{ type: "output_text", text: "Fixed the sidebar." }],
		}),
	]);
	const importer = new DesktopSessionImporter();
	const { items } = await importer.list("codex", file.root);
	const result = await importer.preview(items[0].id);
	expect(result.actions.map((action) => action.displayText)).toEqual([
		"Fix the sidebar",
		"",
		"Checking the sidebar.",
		"Fixed the sidebar.",
	]);
	expect(result.actions[1]).toMatchObject({ text: "Private planning", channel: "analysis" });
});

it("repairs old imported channels and hides internal review copies without modifying saved ledgers or Relay continuations", async () => {
	const file = await fixture("codex", [
		user("Real chat"),
		response({
			type: "message",
			role: "assistant",
			channel: "analysis",
			content: [{ type: "output_text", text: "Planning" }],
		}),
		response({
			type: "message",
			role: "assistant",
			channel: "final",
			content: [{ type: "output_text", text: "Done" }],
		}),
	]);
	const directory = join(file.root, "relay");
	const store = new DesktopStore(directory);
	await store.load();
	const internalPath = join(file.root, "guardian.jsonl");
	await writeFile(
		internalPath,
		`${JSON.stringify({ type: "session_meta", payload: { id: "review", thread_source: "guardian_review" } })}\n${JSON.stringify(user("Internal record"))}\n`,
	);
	store.state.sessions.push({
		id: "chat",
		project: file.project,
		name: "Real chat",
		updated: 1,
		accountId: "",
		autoSwitch: true,
		importedFrom: { provider: "codex", sessionId: file.sessionId, path: file.path, importedAt: 2 },
		actions: [
			{ id: "u", kind: "user", text: "Real chat", time: 1 },
			{ id: "a", kind: "assistant", text: "Planning", time: 1 },
			{ id: "b", kind: "assistant", text: "Done", time: 1 },
			{ id: "i", kind: "switch", text: "Imported from Codex.", time: 2 },
			{ id: "c", kind: "assistant", text: "Planning", provider: "Claude", time: 3 },
		],
	});
	store.state.sessions.push({
		...store.state.sessions[0],
		id: "review",
		importedFrom: { provider: "codex", sessionId: "review", path: internalPath, importedAt: 2 },
		actions: [{ id: "r", kind: "user", text: "Internal record", time: 1 }],
	});
	await store.save();
	const runtime = new DesktopRuntime(
		directory,
		{ state: () => {}, permission: async () => true },
		async () => {},
		fakeAccountCatalog,
		[],
	);
	await runtime.initialize();
	const state = await runtime.command({ type: "state" });
	if (!("sessions" in state)) throw new Error("Expected state");
	expect(state.sessions.map((session) => session.id)).toEqual(["chat"]);
	expect(state.sessions[0].actions[1]).toMatchObject({ text: "Planning", channel: "analysis", displayText: "" });
	expect(state.sessions[0].actions.at(-1)).toMatchObject({
		text: "Planning",
		provider: "Claude",
		displayText: "Planning",
	});
	const persisted = new DesktopStore(directory);
	await persisted.load();
	expect(persisted.state.sessions.map((session) => session.actions)).toEqual(
		store.state.sessions.map((session) => session.actions),
	);
	expect(publicHistory(runtime.store.session("chat")).messages.map((message) => message.text)).toEqual([
		"Real chat",
		"Done",
		"Planning",
	]);
});
