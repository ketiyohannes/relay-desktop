import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionKey } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { AccountExhaustedError, isAccountExhausted, sharedContext } from "../../src/desktop/engines.ts";
import { type DesktopEngine, DesktopRuntime } from "../../src/desktop/runtime.ts";
import { DesktopStore } from "../../src/desktop/store.ts";
import { DesktopTimeline } from "../../src/desktop/timeline.ts";
import type { DesktopState } from "../../src/desktop/types.ts";
import { fakeAccountCatalog } from "./fixtures.ts";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "relay-desktop-test-"));
	directories.push(directory);
	await execute("git", ["init", "-q", directory]);
	await writeFile(join(directory, "base.ts"), "export const initial = true;\n");
	await execute("git", ["add", "base.ts"], { cwd: directory });
	await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "baseline"], {
		cwd: directory,
	});
	return directory;
}

describe("desktop timeline", () => {
	it("retains add then delete with full context and leaves HEAD/index unchanged", async () => {
		const cwd = await repository();
		await writeFile(join(cwd, "base.ts"), "export const staged = true;\n");
		await execute("git", ["add", "base.ts"], { cwd });
		await writeFile(join(cwd, "base.ts"), "export const working = true;\n");
		const head = (await execute("git", ["rev-parse", "HEAD"], { cwd })).stdout;
		const index = await readFile(join(cwd, ".git/index"));
		const timeline = new DesktopTimeline(cwd, "test-session");
		const baseline = await timeline.checkpoint("baseline");
		await writeFile(join(cwd, "temporary.ts"), "export const transient = 42;\n");
		const added = await timeline.checkpoint("write");
		await rm(join(cwd, "temporary.ts"));
		const deleted = await timeline.checkpoint("delete");
		expect(added.files).toEqual(["temporary.ts"]);
		expect(deleted.previous).toBe(added.snapshot);
		expect((await timeline.view(added.snapshot, baseline.snapshot, "temporary.ts")).after).toContain(
			"transient = 42",
		);
		const removed = await timeline.view(deleted.snapshot, added.snapshot, "temporary.ts");
		expect(removed.before).toContain("transient = 42");
		expect(removed.after).toBe("");
		expect((await timeline.view(added.snapshot)).files).toEqual(["base.ts", "temporary.ts"]);
		expect(await readFile(join(cwd, ".git/index"))).toEqual(index);
		expect((await execute("git", ["rev-parse", "HEAD"], { cwd })).stdout).toBe(head);
		expect(await readFile(join(cwd, "base.ts"), "utf8")).toContain("working");
	});
});

describe("shared desktop sessions", () => {
	it("preserves opaque Claude transcript entries and deduplicates retried UUIDs", async () => {
		const cwd = await repository();
		const store = new DesktopStore(join(cwd, "data"));
		await store.load();
		const transcripts = store.claudeTranscripts();
		const key: SessionKey = { projectKey: "/a/very/long/project".repeat(30), sessionId: "session-1" };
		const first = { type: "assistant", uuid: "a", nested: { preserved: [1, true, { value: "data" }] } };
		await Promise.all([
			transcripts.append(key, [first]),
			transcripts.append(key, [first, { type: "summary", content: "keep" }]),
		]);
		expect(await transcripts.load(key)).toEqual([first, { type: "summary", content: "keep" }]);
	});

	it("switches once on confirmed exhaustion and supplies completed effects to the next engine", async () => {
		const cwd = await repository();
		const calls: string[] = [];
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		let started = false;
		const engine: DesktopEngine = async (session, account, prompt, _abort, callbacks) => {
			calls.push(account.name);
			if (account.name === "first") {
				await callbacks.tool("write-1", "write", { path: "added.ts" });
				await writeFile(join(cwd, "added.ts"), "export const completed = true;\n");
				await callbacks.tool("write-1", "write", undefined, { result: "done" });
				await callbacks.checkpoint("After write", "write-1");
				throw new AccountExhaustedError("usage_limit_reached");
			}
			expect(prompt).toContain("Do not replay completed");
			expect(sharedContext(session)).toContain("added.ts");
			expect(await readFile(join(cwd, "added.ts"), "utf8")).toContain("completed");
			await callbacks.text("response", "Continued with the completed edit preserved.", true);
		};
		const runtime = new DesktopRuntime(
			join(cwd, ".git/relay-test"),
			{
				state: (state: DesktopState) => {
					if (state.busySession) started = true;
					if (started && !state.busySession) resolveSettled();
				},
				permission: async () => true,
			},
			engine,
			fakeAccountCatalog,
		);
		await runtime.initialize();
		await runtime.command({ type: "project", path: cwd });
		for (const name of ["first", "second"]) {
			await runtime.command({
				type: "account",
				account: { id: "", name, engine: "claude", provider: "", model: "", configDir: "" },
			});
		}
		await runtime.command({ type: "session", project: cwd });
		const session = runtime.store.state.sessions[0];
		await runtime.command({ type: "prompt", sessionId: session.id, text: "Add a file" });
		await settled;
		expect(calls).toEqual(["first", "second"]);
		expect(runtime.store.state.sessions[0].id).toBe(session.id);
		expect(session.actions.filter((a) => a.kind === "tool")).toHaveLength(1);
		expect(session.actions.filter((a) => a.kind === "switch")).toHaveLength(1);
		expect(session.actions.find((a) => a.kind === "tool")?.status).toBe("done");
		expect(session.actions.some((a) => a.kind === "assistant" && a.text.includes("completed edit preserved"))).toBe(
			true,
		);
		const reloaded = new DesktopStore(join(cwd, ".git/relay-test"));
		await reloaded.load();
		expect(reloaded.state.sessions[0].actions).toEqual(session.actions);
	});

	it.each(["all exhausted", "auto disabled", "authentication failure", "cancelled"])(
		"terminates recovery when %s",
		async (scenario) => {
			const cwd = await repository();
			const calls: string[] = [];
			let resolveSettled!: () => void;
			const settled = new Promise<void>((resolve) => {
				resolveSettled = resolve;
			});
			let started = false;
			const runtime = new DesktopRuntime(
				join(cwd, ".git/relay-test"),
				{
					state: (state) => {
						if (state.busySession) started = true;
						if (started && !state.busySession) resolveSettled();
					},
					permission: async () => true,
				},
				async (_session, account, _prompt, abort) => {
					calls.push(account.name);
					if (scenario === "cancelled") abort.abort();
					if (scenario === "authentication failure") throw new Error("401 unauthorized");
					throw new AccountExhaustedError("usage_limit_reached");
				},
				fakeAccountCatalog,
			);
			await runtime.initialize();
			await runtime.command({ type: "project", path: cwd });
			for (const name of ["first", "second", "third"])
				await runtime.command({
					type: "account",
					account: { id: "", name, engine: "claude", configDir: "", provider: "", model: "" },
				});
			await runtime.command({ type: "session", project: cwd });
			const session = runtime.store.state.sessions[0];
			await runtime.command({
				type: "select_account",
				sessionId: session.id,
				accountId: runtime.store.state.accounts[1].id,
				autoSwitch: scenario !== "auto disabled",
			});
			await runtime.command({ type: "prompt", sessionId: session.id, text: "Continue" });
			await settled;
			expect(calls).toEqual(scenario === "all exhausted" ? ["second", "third", "first"] : ["second"]);
			expect(session.actions.filter((a) => a.kind === "switch" && a.text.includes("exhausted"))).toHaveLength(
				scenario === "all exhausted" ? 2 : 0,
			);
			expect(session.actions.filter((a) => a.kind === "switch" && a.text.includes("manual"))).toHaveLength(1);
			expect(runtime.store.state.busySession).toBeUndefined();
		},
	);

	it("distinguishes quota exhaustion from transient and authentication errors", () => {
		expect(isAccountExhausted("usage_limit_reached")).toBe(true);
		expect(isAccountExhausted("subscription_sharing_usage_limit_exceeded")).toBe(true);
		for (const error of ["429 too many requests", "401 unauthorized", "context length exceeded", "network timeout"]) {
			expect(isAccountExhausted(error)).toBe(false);
		}
	});
});
