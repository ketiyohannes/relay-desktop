import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexRateLimits } from "../../src/desktop/codex-usage.ts";
import type { AccountUsage, DesktopAccount } from "../../src/desktop/types.ts";
import {
	AccountUsageService,
	claudeUsage,
	codexUsage,
	loadAccountUsage,
	loadClaudeUsage,
} from "../../src/desktop/usage.ts";

const account: DesktopAccount = {
	id: "test",
	name: "Test",
	engine: "pi",
	provider: "openai-codex",
	configDir: "/isolated",
	model: "test",
};
const snapshot = {
	planType: "plus",
	primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 },
	secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: 1900100000 },
};
afterEach(() => vi.useRealTimers());

describe("provider usage normalization", () => {
	it("identifies windows by duration and converts resets and remaining allowance", () => {
		const result = codexUsage("test", {
			rateLimits: { ...snapshot, primary: snapshot.secondary, secondary: snapshot.primary },
		});
		expect(result.windows).toEqual([
			{ id: "codex/primary", label: "Weekly", remainingPercent: 30, resetsAt: 1900100000000 },
			{ id: "codex/secondary", label: "5 hours", remainingPercent: 75, resetsAt: 1900000000000 },
		]);
	});
	it("omits five-hour windows for Pro but retains reported Business windows", () => {
		for (const planType of ["pro", "prolite", "promax"]) {
			const pro = codexUsage("test", { rateLimits: { ...snapshot, planType } });
			expect(pro.noFiveHourLimit).toBe(true);
			expect(pro.windows.map((window) => window.label)).toEqual(["Weekly"]);
		}
		expect(codexUsage("test", { rateLimits: { ...snapshot, planType: "business" } }).windows).toHaveLength(2);
	});
	it("preserves model buckets and unknown percentages without inventing remaining quota", () => {
		const result = codexUsage("test", {
			rateLimitsByLimitId: {
				codex: snapshot,
				fast: { limitName: "Fast", primary: { usedPercent: null, windowDurationMins: 10080 } },
			},
		});
		expect(result.windows).toHaveLength(3);
		expect(result.windows[2]).toMatchObject({ label: "Fast · Weekly", remainingPercent: null });
		expect(codexUsage("test", null)).toMatchObject({ status: "unavailable", windows: [] });
	});
	it("handles Claude model-specific limits and null or unavailable subscription data", () => {
		const result = claudeUsage("test", {
			subscription_type: "max",
			rate_limits_available: true,
			rate_limits: {
				five_hour: { utilization: 120, resets_at: "2030-01-01T00:00:00Z" },
				seven_day: { utilization: null, resets_at: "invalid" },
				model_scoped: [{ display_name: "Sonnet", utilization: 15 }],
			},
		});
		expect(result.windows).toEqual([
			{ id: "five_hour", label: "5 hours", remainingPercent: 0, resetsAt: Date.parse("2030-01-01T00:00:00Z") },
			{ id: "seven_day", label: "Weekly", remainingPercent: null },
			{ id: "model/0", label: "Sonnet · Weekly", remainingPercent: 85 },
		]);
		expect(
			claudeUsage("test", { rate_limits_available: false, rate_limits: { five_hour: { utilization: 0 } } }),
		).toMatchObject({ status: "unavailable", windows: [] });
	});
	it("does not read subscription credentials for API accounts", async () => {
		expect(await loadAccountUsage({ ...account, provider: "openai" }, new AbortController().signal)).toMatchObject({
			status: "unsupported",
			windows: [],
		});
	});
});

describe("usage lifecycle", () => {
	it("uses Claude metadata only and closes the SDK input on completion", async () => {
		const close = vi.fn();
		let input: Promise<IteratorResult<unknown>> | undefined;
		await loadClaudeUsage({ ...account, engine: "claude" }, new AbortController().signal, ({ prompt, options }) => {
			expect(options.env?.CLAUDE_CONFIG_DIR).toBe("/isolated");
			expect(options.persistSession).toBe(false);
			expect(options.tools).toEqual([]);
			input = prompt[Symbol.asyncIterator]().next();
			return {
				close,
				usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (params) => {
					expect(params).toEqual({ skipBehaviors: true });
					return {
						subscription_type: "max",
						rate_limits_available: false,
						rate_limits: null,
						behaviors: null,
						session: {
							total_cost_usd: 0,
							total_api_duration_ms: 0,
							total_duration_ms: 0,
							total_lines_added: 0,
							total_lines_removed: 0,
							model_usage: {},
						},
					};
				},
			};
		});
		expect(close).toHaveBeenCalledOnce();
		expect(await input).toEqual({ done: true, value: undefined });
	});
	it("closes stalled Claude usage on cancellation even if the SDK ignores abort", async () => {
		const abort = new AbortController();
		const close = vi.fn();
		const result = loadClaudeUsage({ ...account, engine: "claude" }, abort.signal, () => ({
			close,
			usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}),
		}));
		const failure = expect(result).rejects.toThrow("cancelled");
		abort.abort();
		await failure;
		expect(close).toHaveBeenCalledOnce();
	});
	it("coalesces reads, caches for one minute, refreshes and invalidates edited profiles", async () => {
		vi.useFakeTimers();
		const loader = vi.fn(async (): Promise<AccountUsage> => codexUsage(account.id, { rateLimits: snapshot }));
		const service = new AccountUsageService(loader);
		await Promise.all([service.read(account), service.read(account, true)]);
		await service.read(account);
		expect(loader).toHaveBeenCalledTimes(1);
		await service.read(account, true);
		await service.read({ ...account, configDir: "/changed" });
		await vi.advanceTimersByTimeAsync(60001);
		await service.read({ ...account, configDir: "/changed" });
		expect(loader).toHaveBeenCalledTimes(4);
	});
	it("clears stale percentages and redacts loader errors", async () => {
		const loader = vi.fn(async () => codexUsage(account.id, { rateLimits: snapshot }));
		const service = new AccountUsageService(loader);
		await service.read(account);
		loader.mockRejectedValueOnce(new Error("secret-token"));
		const result = await service.read(account, true);
		expect(result).toMatchObject({ status: "unavailable", windows: [] });
		expect(JSON.stringify(result)).not.toContain("secret-token");
	});
	it("bounds stalled reads and aborts their provider process", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const service = new AccountUsageService((_account, nextSignal) => {
			signal = nextSignal;
			return new Promise(() => {});
		});
		const result = service.read(account);
		await vi.advanceTimersByTimeAsync(22000);
		expect(await result).toMatchObject({ status: "unavailable", windows: [] });
		expect(signal?.aborted).toBe(true);
	});
});

describe("Codex metadata transport", () => {
	const auth = { accessToken: "synthetic-never-send", chatgptAccountId: "synthetic" };
	const fixture = fileURLToPath(new URL("./usage-server.mjs", import.meta.url));
	it("performs only initialization, external auth and usage, then removes isolated files", async () => {
		let directory = "";
		const result = await readCodexRateLimits(auth, new AbortController().signal, (cwd) => {
			directory = cwd;
			return spawn(process.execPath, [fixture], { cwd });
		});
		expect(result).toEqual({ accountId: "synthetic", rateLimits: { planType: "pro" } });
		await expect(access(directory)).rejects.toThrow();
	});
	it("settles when the executable cannot launch", async () => {
		await expect(
			readCodexRateLimits(auth, new AbortController().signal, (cwd) =>
				spawn("/does-not-exist-relay-codex", [], { cwd }),
			),
		).rejects.toThrow("CLI unavailable");
	});
	it("aborts and cleans up a stalled child", async () => {
		const abort = new AbortController();
		let directory = "";
		const result = readCodexRateLimits(auth, abort.signal, (cwd) => {
			directory = cwd;
			const child = spawn(process.execPath, [fixture, "stall"], { cwd });
			child.once("spawn", () => abort.abort());
			return child;
		});
		await expect(result).rejects.toThrow("timed out");
		await expect(access(directory)).rejects.toThrow();
	});
});
