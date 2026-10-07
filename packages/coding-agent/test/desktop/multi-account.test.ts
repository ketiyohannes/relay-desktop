import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountCatalogLoader } from "../../src/desktop/accounts.ts";
import { AccountExhaustedError, sharedContext } from "../../src/desktop/engines.ts";
import { type DesktopEngine, DesktopRuntime } from "../../src/desktop/runtime.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const catalog: AccountCatalogLoader = async (account) => ({
	configDir: account.configDir,
	connected: true,
	models: [account.model, "alternate"].map((id) => ({
		id,
		name: id,
		provider: account.provider,
		authenticated: true,
	})),
});
async function setup(engine?: DesktopEngine, load: AccountCatalogLoader = catalog) {
	const cwd = await mkdtemp(join(tmpdir(), "relay-multi-"));
	directories.push(cwd);
	await promisify(execFile)("git", ["init", "-q", cwd]);
	const runtime = new DesktopRuntime(
		join(cwd, ".git/relay"),
		{ state: () => {}, permission: async () => true },
		engine,
		load,
	);
	await runtime.initialize();
	await runtime.command({ type: "project", path: cwd });
	for (const [name, engine] of [
		["Codex A", "pi"],
		["Claude", "claude"],
		["Codex B", "pi"],
	] as const) {
		await runtime.command({
			type: "account",
			account: {
				id: "",
				name,
				engine,
				provider: engine === "pi" ? "openai-codex" : "",
				model: engine === "pi" ? "codex" : "sonnet",
				configDir: "",
			},
		});
	}
	await runtime.command({ type: "session", project: cwd });
	return runtime;
}

describe("multi-account routing", () => {
	it("lists every account without exposing discovery failures or hiding healthy profiles", async () => {
		let failing = false;
		const runtime = await setup(undefined, async (account) => {
			if (failing && account.engine === "claude") throw new Error("secret credential detail");
			return catalog(account);
		});
		failing = true;
		const result = await runtime.command({ type: "account_catalogs" });
		expect(result).toMatchObject({
			accounts: [
				{ accountId: runtime.store.state.accounts[0].id, catalog: { connected: true } },
				{
					accountId: runtime.store.state.accounts[1].id,
					error: expect.stringContaining("Connection check failed"),
				},
				{ accountId: runtime.store.state.accounts[2].id, catalog: { connected: true } },
			],
		});
		expect(JSON.stringify(result)).not.toContain("secret credential detail");
	});
	it("selects a model on another account atomically and retains independent choices", async () => {
		const runtime = await setup();
		const session = runtime.store.state.sessions[0];
		const [codex, claude] = runtime.store.state.accounts;
		await runtime.command({ type: "select_model", sessionId: session.id, accountId: claude.id, model: "alternate" });
		expect(session.accountId).toBe(claude.id);
		await expect(
			runtime.command({ type: "select_model", sessionId: session.id, accountId: codex.id, model: "missing" }),
		).rejects.toThrow("not available");
		expect(session.accountId).toBe(claude.id);
		await runtime.command({ type: "select_model", sessionId: session.id, accountId: codex.id, model: "alternate" });
		expect(session.models).toEqual({ [codex.id]: "alternate", [claude.id]: "alternate" });
		expect(claude.model).toBe("sonnet");
	});
	it("continues Codex → Claude → Codex in the same session with completed tool output and selected models", async () => {
		const calls: string[] = [];
		let identity = "";
		const runtime = await setup(async (session, account, _prompt, _abort, callbacks) => {
			calls.push(account.name);
			expect(session.id).toBe(identity);
			if (calls.length === 1) {
				await callbacks.tool("completed", "write", { path: "test.ts" }, "saved output");
				throw new AccountExhaustedError("usage_limit_reached");
			}
			expect(sharedContext(session)).toContain("saved output");
			if (account.engine === "claude") {
				expect(account.model).toBe("alternate");
				await callbacks.session("native-claude-session");
				throw new AccountExhaustedError("weekly usage limit");
			}
			expect(session.claudeSessionId).toBe("native-claude-session");
			await callbacks.text("done", "Finished", true);
		});
		const session = runtime.store.state.sessions[0];
		identity = session.id;
		session.models = { [runtime.store.state.accounts[1].id]: "alternate" };
		await runtime.command({ type: "prompt", sessionId: session.id, text: "Continue work" });
		await expect.poll(() => runtime.store.state.busySession).toBeUndefined();
		expect(calls).toEqual(["Codex A", "Claude", "Codex B"]);
		expect(session.actions.filter((action) => action.kind === "tool")).toHaveLength(1);
		expect(session.actions.some((action) => action.text === "Finished")).toBe(true);
	});
	it.each(["unauthenticated", "missing model", "offline"])("skips a fallback that is %s", async (scenario) => {
		let running = false;
		const calls: string[] = [];
		const runtime = await setup(
			async (_session, account) => {
				calls.push(account.name);
				if (account.name === "Codex A") throw new AccountExhaustedError("usage_limit_reached");
			},
			async (account) => {
				const result = await catalog(account);
				if (running && account.engine === "claude") {
					if (scenario === "offline") throw new Error("offline");
					if (scenario === "missing model") result.models = [];
					else result.connected = false;
				}
				return result;
			},
		);
		running = true;
		const session = runtime.store.state.sessions[0];
		await runtime.command({ type: "prompt", sessionId: session.id, text: "Continue" });
		await expect.poll(() => runtime.store.state.busySession).toBeUndefined();
		expect(calls).toEqual(["Codex A", "Codex B"]);
		expect(session.actions.some((action) => action.text.startsWith("Skipped Claude"))).toBe(true);
	});
	it.each(["cancel", "disable auto"])("honors %s during fallback discovery", async (action) => {
		let running = false;
		let discovered = false;
		let resume!: () => void;
		const pending = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const calls: string[] = [];
		const runtime = await setup(
			async (_session, account) => {
				calls.push(account.name);
				throw new AccountExhaustedError("usage_limit_reached");
			},
			async (account) => {
				if (running) {
					discovered = true;
					await pending;
				}
				return catalog(account);
			},
		);
		running = true;
		const session = runtime.store.state.sessions[0];
		await runtime.command({ type: "prompt", sessionId: session.id, text: "Continue" });
		await expect.poll(() => discovered).toBe(true);
		if (action === "cancel") await runtime.command({ type: "cancel" });
		else
			await runtime.command({
				type: "select_account",
				sessionId: session.id,
				accountId: session.accountId,
				autoSwitch: false,
			});
		resume();
		await expect.poll(() => runtime.store.state.busySession).toBeUndefined();
		expect(calls).toEqual(["Codex A"]);
		expect(session.accountId).toBe(runtime.store.state.accounts[0].id);
	});
});
