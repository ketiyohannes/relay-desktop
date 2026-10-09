import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AccountCatalogLoader,
	claudeAccountCatalog,
	codexAccountCatalog,
} from "../../../src/core/desktop/accounts.ts";
import type { DesktopAccount, DesktopState } from "../../../src/core/desktop/types.ts";
import { DesktopRuntime } from "./offline-runtime.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function directory(): Promise<string> {
	const result = await mkdtemp(join(tmpdir(), "relay-accounts-"));
	directories.push(result);
	return result;
}
const catalog: AccountCatalogLoader = async (account) => ({
	configDir: account.configDir,
	connected: true,
	models: ["first", "second"].map((id) => ({ id, name: id, provider: account.provider, authenticated: true })),
});
const account: DesktopAccount = {
	id: "",
	name: "Test",
	engine: "pi",
	configDir: "",
	provider: "openai-codex",
	model: "first",
};

describe("account catalogs and model selection", () => {
	it("reuses catalog discovery when reopening the picker or selecting a model, and supports explicit refresh", async () => {
		const cwd = await directory();
		const loader = vi.fn(catalog);
		const runtime = new DesktopRuntime(
			join(cwd, "data"),
			{ state: () => {}, permission: async () => true },
			undefined,
			loader,
		);
		await runtime.initialize();
		await runtime.command({ type: "project", path: cwd });
		await runtime.command({ type: "account", account });
		await runtime.command({ type: "session", project: cwd });
		loader.mockClear();
		await Promise.all([runtime.command({ type: "account_catalogs" }), runtime.command({ type: "account_catalogs" })]);
		await runtime.command({ type: "account_catalogs" });
		const session = runtime.store.state.sessions[0];
		await runtime.command({
			type: "select_model",
			sessionId: session.id,
			accountId: session.accountId,
			model: "second",
		});
		expect(loader).toHaveBeenCalledTimes(1);
		await runtime.command({ type: "account_catalogs", refresh: true });
		expect(loader).toHaveBeenCalledTimes(2);
	});
	it("bounds stalled Claude metadata requests and closes their process", async () => {
		vi.useFakeTimers();
		try {
			let closed = false;
			const discovery = claudeAccountCatalog({ ...account, engine: "claude" }, () => ({
				supportedModels: () => new Promise(() => {}),
				accountInfo: () => new Promise(() => {}),
				close: () => {
					closed = true;
				},
			}));
			const failure = expect(discovery).rejects.toThrow("discovery timed out");
			await vi.advanceTimersByTimeAsync(20000);
			await failure;
			expect(closed).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
	it("uses SDK metadata without sending a prompt and closes the discovery process", async () => {
		let closed = false;
		let inputEnded: Promise<IteratorResult<unknown>> | undefined;
		const result = await claudeAccountCatalog(
			{ ...account, engine: "claude", configDir: "/isolated-profile" },
			({ prompt, options }) => {
				expect(options.env?.CLAUDE_CONFIG_DIR).toBe("/isolated-profile");
				expect(options.tools).toEqual([]);
				expect(options.persistSession).toBe(false);
				inputEnded = prompt[Symbol.asyncIterator]().next();
				return {
					supportedModels: async () => [{ value: "sonnet", displayName: "Sonnet", description: "Balanced" }],
					accountInfo: async () => ({ email: "test@example.test", tokenSource: "oauth", subscriptionType: "max" }),
					close: () => {
						closed = true;
					},
				};
			},
		);
		expect(closed).toBe(true);
		expect(await inputEnded).toEqual({ done: true, value: undefined });
		expect(result.models[0]).toMatchObject({ id: "sonnet", authenticated: true });
		expect(result.identity).toBe("test@example.test · max");
		expect(result.identityKey).toBe(JSON.stringify(["test@example.test", ""]));
	});
	it("reads native Codex credentials through the existing storage adapter without modifying them", async () => {
		const configDir = await directory();
		const auth = JSON.stringify({
			auth_mode: "chatgpt",
			tokens: {
				access_token: `header.${Buffer.from(JSON.stringify({ exp: 4000000000 })).toString("base64url")}.signature`,
				refresh_token: "synthetic",
				account_id: "test",
			},
		});
		await writeFile(join(configDir, "auth.json"), auth);
		const calls: string[] = [];
		let closed = false;
		const result = await codexAccountCatalog({ ...account, configDir, credentialSource: "codex" }, (profile) => {
			expect(profile).toBe(configDir);
			return {
				request: async (method, params) => {
					calls.push(method);
					if (method === "account/read") {
						expect(params).toEqual({ refreshToken: false });
						return { account: { email: "test@example.test", planType: "plus" } };
					}
					if (method === "model/list")
						return {
							data: [{ id: "id", model: "native", displayName: "Native", description: "Fixture" }],
							nextCursor: null,
						};
					return {};
				},
				notify: () => {},
				close: async () => {
					closed = true;
					return "settled";
				},
			};
		});
		expect(calls).toEqual(["initialize", "account/read", "model/list"]);
		expect(closed).toBe(true);
		expect(result.connected).toBe(true);
		expect(result.identityKey).toBe("test@example.test");
		expect(result.models.length).toBeGreaterThan(0);
		expect(result.models.every((model) => model.provider === "openai-codex")).toBe(true);
		expect(JSON.stringify(result)).not.toContain("synthetic");
		expect(await readFile(join(configDir, "auth.json"), "utf8")).toBe(auth);
	});
	it.each(["pi", "claude"] as const)(
		"reuses repeated %s login identities and preserves session models",
		async (engine) => {
			const cwd = await directory();
			const profiles = [await directory(), await directory()];
			const runtime = new DesktopRuntime(
				join(cwd, "data"),
				{ state: () => {}, permission: async () => true },
				undefined,
				async (account) => ({ ...(await catalog(account)), identityKey: "same-identity" }),
			);
			await runtime.initialize();
			await runtime.command({ type: "project", path: cwd });
			await runtime.command({ type: "account", account: { ...account, engine, configDir: profiles[0] } });
			await runtime.command({ type: "session", project: cwd });
			const session = runtime.store.state.sessions[0];
			const id = session.accountId;
			await runtime.command({ type: "select_model", sessionId: session.id, accountId: id, model: "second" });
			await runtime.command({
				type: "account",
				account: { ...account, engine, name: "Duplicate login", configDir: profiles[1] },
			});
			expect(runtime.store.state.accounts).toHaveLength(1);
			expect(runtime.store.state.accounts[0]).toMatchObject({
				id,
				name: "Test",
				configDir: profiles[1],
				equivalentProfiles: [profiles[0]],
			});
			expect(session.accountId).toBe(id);
			expect(session.models?.[id]).toBe("second");
			const saved = JSON.parse(await readFile(join(cwd, "data/state.json"), "utf8")) as DesktopState;
			expect(saved.accounts).toHaveLength(1);
		},
	);
	it("merges previously saved duplicate identities on startup without losing their selected model", async () => {
		const cwd = await directory();
		const profiles = [await directory(), await directory(), await directory()];
		await writeFile(
			join(cwd, "state.json"),
			JSON.stringify({
				projects: [],
				accounts: profiles.map((configDir, index) => ({
					...account,
					id: String(index),
					configDir,
				})),
				sessions: [
					{
						id: "saved",
						accountId: "1",
						project: cwd,
						name: "Saved",
						updated: 1,
						autoSwitch: true,
						models: { "1": "second" },
						actions: [],
					},
				],
			}),
		);
		const runtime = new DesktopRuntime(
			cwd,
			{ state: () => {}, permission: async () => true },
			undefined,
			async (selected) => ({
				...(await catalog(selected)),
				identityKey: selected.configDir === profiles[2] ? "other" : "same",
			}),
		);
		await runtime.initialize();
		expect(runtime.store.state.accounts).toHaveLength(2);
		expect(runtime.store.state.sessions[0]).toMatchObject({ accountId: "0", models: { "0": "second" } });
		expect(runtime.store.state.accounts[0].equivalentProfiles).toEqual([profiles[1]]);
		expect(runtime.store.state.sessions[0].models?.["1"]).toBeUndefined();
	});
	it("persists model changes per session and per account without changing account defaults", async () => {
		const cwd = await directory();
		const runtime = new DesktopRuntime(
			join(cwd, "data"),
			{ state: () => {}, permission: async () => true },
			undefined,
			catalog,
		);
		await runtime.initialize();
		await runtime.command({ type: "project", path: cwd });
		await runtime.command({ type: "account", account });
		await runtime.command({ type: "session", project: cwd });
		await runtime.command({ type: "session", project: cwd });
		const [first, second] = runtime.store.state.sessions;
		const id = runtime.store.state.accounts[0].id;
		await runtime.command({ type: "select_model", sessionId: first.id, accountId: id, model: "second" });
		expect(first.models?.[id]).toBe("second");
		expect(second.models).toBeUndefined();
		expect(runtime.store.state.accounts[0].model).toBe("first");
		await expect(
			runtime.command({ type: "select_model", sessionId: first.id, accountId: id, model: "invented" }),
		).rejects.toThrow("not available");
		const saved = JSON.parse(await readFile(join(cwd, "data/state.json"), "utf8")) as DesktopState;
		expect(saved.sessions[0].models?.[id]).toBe("second");
		expect(first.actions.filter((action) => action.kind === "switch")).toHaveLength(1);
	});
	it("rejects profiles with missing authentication", async () => {
		const cwd = await directory();
		const runtime = new DesktopRuntime(cwd, { state: () => {}, permission: async () => true }, undefined, async () => ({
			configDir: cwd,
			connected: false,
			models: [],
		}));
		await runtime.initialize();
		await expect(runtime.command({ type: "account", account })).rejects.toThrow("No authentication");
		expect(runtime.store.state.accounts).toEqual([]);
	});
	it("rejects a stale model selection when the account changes during discovery", async () => {
		const cwd = await directory();
		let pause = false;
		let resume!: () => void;
		const pending = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const runtime = new DesktopRuntime(
			join(cwd, "data"),
			{ state: () => {}, permission: async () => true },
			undefined,
			async (account) => {
				if (pause) await pending;
				return catalog(account);
			},
		);
		await runtime.initialize();
		await runtime.command({ type: "project", path: cwd });
		await runtime.command({ type: "account", account });
		await runtime.command({ type: "account", account: { ...account, name: "Other" } });
		await runtime.command({ type: "session", project: cwd });
		const session = runtime.store.state.sessions[0];
		pause = true;
		const selection = runtime.command({
			type: "select_model",
			sessionId: session.id,
			accountId: session.accountId,
			model: "second",
		});
		await runtime.command({
			type: "select_account",
			sessionId: session.id,
			accountId: runtime.store.state.accounts[1].id,
			autoSwitch: true,
		});
		resume();
		await expect(selection).rejects.toThrow("active account changed");
		expect(session.models).toBeUndefined();
	});
	it("runs the session model and keeps streamed tool output pending until completion", async () => {
		const cwd = await directory();
		await promisify(execFile)("git", ["init", "-q", cwd]);
		const observed: DesktopState[] = [];
		const runtime = new DesktopRuntime(
			join(cwd, ".git/data"),
			{ state: (state) => observed.push(structuredClone(state)), permission: async () => true },
			async (_session, selected, _prompt, _abort, callbacks) => {
				expect(selected.model).toBe("second");
				await callbacks.tool("tool-1", "bash", { command: "echo test" });
				await callbacks.toolProgress?.("tool-1", "Running", {
					content: [{ type: "text", text: "partial output" }],
				});
				await expect
					.poll(() =>
						observed.some((state) =>
							state.sessions[0]?.actions.some(
								(action) => action.status === "running" && action.output?.includes("partial output"),
							),
						),
					)
					.toBe(true);
				await callbacks.tool("tool-1", "bash", undefined, "final output");
				await callbacks.text("response", "Done", true);
			},
			catalog,
		);
		await runtime.initialize();
		await runtime.command({ type: "project", path: cwd });
		await runtime.command({ type: "account", account });
		await runtime.command({ type: "session", project: cwd });
		const session = runtime.store.state.sessions[0];
		await runtime.command({
			type: "select_model",
			sessionId: session.id,
			accountId: session.accountId,
			model: "second",
		});
		await runtime.command({ type: "prompt", sessionId: session.id, text: "Test" });
		await expect.poll(() => runtime.store.state.busySession).toBeUndefined();
		expect(
			observed.some((state) =>
				state.sessions[0]?.actions.some(
					(action) => action.status === "running" && action.output?.includes("partial output"),
				),
			),
		).toBe(true);
		const tools = session.actions.filter((action) => action.kind === "tool");
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ status: "done", output: "final output" });
		expect(tools[0].input).toContain("echo test");
		expect(tools[0].finished).toBeGreaterThanOrEqual(tools[0].time);
	});
});
