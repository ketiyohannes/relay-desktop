import { homedir } from "node:os";
import { join } from "node:path";
import { type Options, type Query, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type CodexTransport, StdioCodexTransport } from "../runtimes/codex/transport.ts";
import { claudeProfileEnv } from "./accounts.ts";
import { expandTildePath } from "./config.ts";
import type { AccountUsage, DesktopAccount } from "./types.ts";

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function remaining(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, 100 - value)) : null;
}

/** Window duration, not primary/secondary position, determines the display label. */
export function codexUsage(accountId: string, value: unknown, fallbackPlan?: string): AccountUsage {
	const response = object(value);
	const buckets = object(response.rateLimitsByLimitId);
	const entries = Object.keys(buckets).length ? Object.entries(buckets) : [["codex", response.rateLimits]];
	const main = object(buckets.codex || response.rateLimits);
	const plan = typeof main.planType === "string" ? main.planType : fallbackPlan;
	const noFiveHourLimit = !!plan && /^pro(?:lite|max)?(?:$|[_-])/.test(plan.toLowerCase());
	const windows: AccountUsage["windows"] = [];
	for (const [key, raw] of entries) {
		const bucket = object(raw);
		for (const position of ["primary", "secondary"] as const) {
			const window = object(bucket[position]);
			if (!Object.keys(window).length) continue;
			const minutes = window.windowDurationMins;
			if (noFiveHourLimit && minutes === 300) continue;
			const duration =
				minutes === 300
					? "5 hours"
					: minutes === 10080
						? "Weekly"
						: typeof minutes === "number" && minutes > 0
							? `${minutes >= 60 ? minutes / 60 : minutes} ${minutes >= 60 ? "hours" : "minutes"}`
							: "Usage window";
			const label =
				key === "codex" ? duration : `${typeof bucket.limitName === "string" ? bucket.limitName : key} · ${duration}`;
			windows.push({
				id: `${key}/${position}`,
				label,
				remainingPercent: remaining(window.usedPercent),
				...(typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
					? { resetsAt: window.resetsAt * 1000 }
					: {}),
			});
		}
	}
	return {
		accountId,
		status: windows.length ? "available" : "unavailable",
		checkedAt: Date.now(),
		plan,
		noFiveHourLimit,
		windows,
		...(!windows.length ? { message: "No usage windows reported by Codex." } : {}),
	};
}

export function claudeUsage(accountId: string, value: unknown): AccountUsage {
	const response = object(value);
	const limits = object(response.rate_limits);
	const plan = typeof response.subscription_type === "string" ? response.subscription_type : undefined;
	const windows: AccountUsage["windows"] = [];
	if (response.rate_limits_available === true) {
		const entries: [string, string, unknown][] = [
			["five_hour", "5 hours", limits.five_hour],
			["seven_day", "Weekly", limits.seven_day],
			["seven_day_opus", "Opus · Weekly", limits.seven_day_opus],
			["seven_day_sonnet", "Sonnet · Weekly", limits.seven_day_sonnet],
			["seven_day_oauth_apps", "OAuth apps · Weekly", limits.seven_day_oauth_apps],
		];
		if (Array.isArray(limits.model_scoped))
			limits.model_scoped.forEach((value, index) => {
				const row = object(value);
				if (typeof row.display_name === "string") entries.push([`model/${index}`, `${row.display_name} · Weekly`, row]);
			});
		for (const [id, label, raw] of entries) {
			if (!raw) continue;
			const row = object(raw);
			const reset = typeof row.resets_at === "string" ? Date.parse(row.resets_at) : NaN;
			windows.push({
				id,
				label,
				remainingPercent: remaining(row.utilization),
				...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
			});
		}
	}
	return {
		accountId,
		checkedAt: Date.now(),
		plan,
		windows,
		status: windows.length ? "available" : "unavailable",
		...(!windows.length ? { message: "Claude did not report subscription limits for this profile." } : {}),
	};
}

type UsageQuery = (args: {
	prompt: AsyncIterable<SDKUserMessage>;
	options: Options;
}) => Pick<Query, "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET" | "close">;

/** Isolate the pinned SDK's experimental /usage control method; no inference or transcript scan. */
export async function loadClaudeUsage(
	account: DesktopAccount,
	signal: AbortSignal,
	invoke: UsageQuery = query,
): Promise<AccountUsage> {
	const abort = new AbortController();
	let request: ReturnType<UsageQuery> | undefined;
	let rejectCancelled: (error: Error) => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		rejectCancelled = reject;
	});
	const cancel = () => {
		abort.abort();
		rejectCancelled(new Error("Usage request cancelled"));
	};
	signal.addEventListener("abort", cancel, { once: true });
	const configDir = expandTildePath(account.configDir || join(homedir(), ".claude"));
	async function* input(): AsyncGenerator<SDKUserMessage> {
		if (!abort.signal.aborted)
			await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
	}
	try {
		signal.throwIfAborted();
		request = invoke({
			prompt: input(),
			options: {
				cwd: configDir,
				env: claudeProfileEnv(configDir),
				abortController: abort,
				settingSources: [],
				tools: [],
				persistSession: false,
			},
		});
		return claudeUsage(
			account.id,
			await Promise.race([
				request.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
				cancelled,
			]),
		);
	} finally {
		signal.removeEventListener("abort", cancel);
		abort.abort();
		request?.close();
	}
}

export type AccountUsageLoader = (account: DesktopAccount, signal: AbortSignal) => Promise<AccountUsage>;
export const loadAccountUsage: AccountUsageLoader = async (account, signal) => {
	if (account.engine === "claude") return loadClaudeUsage(account, signal);
	if (account.provider !== "openai-codex")
		return {
			accountId: account.id,
			status: "unsupported",
			checkedAt: Date.now(),
			windows: [],
			message: "Subscription usage windows are available for Codex and Claude accounts.",
		};
	return loadCodexUsage(account, signal);
};

export async function loadCodexUsage(
	account: DesktopAccount,
	signal: AbortSignal,
	connect: (profile: string) => Pick<CodexTransport, "request" | "notify" | "close"> = (profile) =>
		new StdioCodexTransport(profile),
): Promise<AccountUsage> {
	signal.throwIfAborted();
	const directory = expandTildePath(account.configDir || process.env.CODEX_HOME || join(homedir(), ".codex"));
	const transport = connect(directory);
	const cancel = () => {
		void transport.close();
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		signal.throwIfAborted();
		await transport.request("initialize", { clientInfo: { name: "relay_usage", version: "0.0.3" } });
		transport.notify("initialized");
		return codexUsage(account.id, await transport.request("account/rateLimits/read", {}));
	} finally {
		signal.removeEventListener("abort", cancel);
		await transport.close();
	}
}

export class AccountUsageService {
	private readonly loader: AccountUsageLoader;
	private readonly cache = new Map<string, { key: string; value?: AccountUsage; pending?: Promise<AccountUsage> }>();
	constructor(loader: AccountUsageLoader = loadAccountUsage) {
		this.loader = loader;
	}
	async read(account: DesktopAccount, refresh = false): Promise<AccountUsage> {
		const key = JSON.stringify([account.engine, account.provider, account.configDir, account.credentialSource]);
		const previous = this.cache.get(account.id);
		if (previous?.key === key) {
			if (previous.pending) return previous.pending;
			if (!refresh && previous.value && Date.now() - previous.value.checkedAt < 60000) return previous.value;
		}
		const entry: { key: string; value?: AccountUsage; pending?: Promise<AccountUsage> } = { key };
		this.cache.set(account.id, entry);
		const abort = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				abort.abort();
				reject(new Error("Usage timed out"));
			}, 22000);
		});
		entry.pending = Promise.race([Promise.resolve().then(() => this.loader(account, abort.signal)), timeout])
			.catch(
				(): AccountUsage => ({
					accountId: account.id,
					checkedAt: Date.now(),
					status: "unavailable",
					windows: [],
					message:
						account.engine === "claude"
							? "Could not read Claude usage. Refresh or reconnect the account."
							: "Could not read Codex usage. Check Codex CLI availability, then refresh or reconnect.",
				}),
			)
			.then((value) => {
				entry.value = value;
				return value;
			})
			.finally(() => {
				clearTimeout(timer!);
				abort.abort();
				entry.pending = undefined;
			});
		return entry.pending;
	}
}
