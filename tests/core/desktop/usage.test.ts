import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountUsage, DesktopAccount } from "../../../src/core/desktop/types.ts";
import {
	AccountUsageService,
	claudeUsage,
	codexUsage,
	loadAccountUsage,
	loadClaudeUsage,
	loadCodexUsage,
} from "../../../src/core/desktop/usage.ts";

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
	it("uses native profile metadata without sending a turn or credential request", async () => {
		const calls: string[] = [];
		const close = vi.fn(async () => "settled" as const);
		const result = await loadCodexUsage(account, new AbortController().signal, (profile) => {
			expect(profile).toBe("/isolated");
			return {
				request: async (method) => {
					calls.push(method);
					return { rateLimits: snapshot };
				},
				notify: () => {},
				close,
			};
		});
		expect(result.windows).toHaveLength(2);
		expect(calls).toEqual(["initialize", "account/rateLimits/read"]);
		expect(close).toHaveBeenCalledOnce();
	});
	it("closes a failed metadata connection", async () => {
		const close = vi.fn(async () => "settled" as const);
		await expect(
			loadCodexUsage(account, new AbortController().signal, () => ({
				request: async () => {
					throw new Error("CLI unavailable");
				},
				notify: () => {},
				close,
			})),
		).rejects.toThrow("CLI unavailable");
		expect(close).toHaveBeenCalledOnce();
	});
	it("cancellation closes native transport and pre-cancelled discovery never launches", async () => {
		const abort = new AbortController();
		let reject!: (error: Error) => void;
		let opened!: () => void;
		const ready = new Promise<void>((resolve) => {
			opened = resolve;
		});
		const close = vi.fn(async () => {
			reject(new Error("Disconnected"));
			return "settled" as const;
		});
		const result = loadCodexUsage(account, abort.signal, () => ({
			request: () =>
				new Promise((_resolve, fail) => {
					reject = fail;
					opened();
				}),
			notify: () => {},
			close,
		}));
		const failure = expect(result).rejects.toThrow("Disconnected");
		await ready;
		abort.abort();
		await failure;
		expect(close).toHaveBeenCalled();
		const connect = vi.fn(() => {
			throw new Error("Must not launch");
		});
		await expect(loadCodexUsage(account, abort.signal, connect)).rejects.toThrow();
		expect(connect).not.toHaveBeenCalled();
	});
});
