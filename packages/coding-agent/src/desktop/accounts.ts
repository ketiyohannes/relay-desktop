import { homedir } from "node:os";
import { join } from "node:path";
import { type Options, type Query, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expandTildePath, getAgentDir } from "../config.ts";
import { ReadOnlyAuthStorage } from "../core/auth-storage.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { CodexAuthStorage } from "./codex-auth.ts";
import type { AccountCatalog, DesktopAccount } from "./types.ts";

export function claudeProfileEnv(configDir: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		...(configDir
			? {
					CLAUDE_CONFIG_DIR: configDir,
					CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined,
					ANTHROPIC_API_KEY: undefined,
					ANTHROPIC_AUTH_TOKEN: undefined,
					CLAUDE_CODE_OAUTH_TOKEN: undefined,
				}
			: {}),
	};
}

export type AccountCatalogLoader = (account: DesktopAccount) => Promise<AccountCatalog>;
export type ClaudeCatalogQuery = (args: {
	prompt: AsyncIterable<SDKUserMessage>;
	options: Options;
}) => Pick<Query, "supportedModels" | "accountInfo" | "close">;

/** SDK control requests only: the input stream never sends a model prompt. */
export async function claudeAccountCatalog(
	account: DesktopAccount,
	invoke: ClaudeCatalogQuery = query,
): Promise<AccountCatalog> {
	const configDir = expandTildePath(account.configDir || join(homedir(), ".claude"));
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			abort.abort();
			reject(new Error("Claude account discovery timed out"));
		}, 20000);
	});
	async function* input(): AsyncGenerator<SDKUserMessage> {
		if (!abort.signal.aborted)
			await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
	}
	let request: ReturnType<ClaudeCatalogQuery> | undefined;
	try {
		request = invoke({
			prompt: input(),
			options: {
				cwd: configDir,
				env: claudeProfileEnv(configDir),
				abortController: abort,
				settingSources: [],
				tools: [],
				permissionMode: "default",
				persistSession: false,
			},
		});
		const [models, info] = await Promise.race([
			Promise.all([request.supportedModels(), request.accountInfo()]),
			timeout,
		]);
		const connected =
			!!info.email || [info.tokenSource, info.apiKeySource].some((source) => !!source && source !== "none");
		return {
			configDir,
			connected,
			identity: [info.email, info.subscriptionType].filter(Boolean).join(" · ") || undefined,
			models: models.map((model) => ({
				provider: "anthropic",
				id: model.value,
				name: model.displayName,
				description: model.description,
				authenticated: connected,
			})),
		};
	} finally {
		clearTimeout(timer!);
		abort.abort();
		request?.close();
	}
}

export const loadAccountCatalog: AccountCatalogLoader = async (account) => {
	if (account.engine === "claude") return claudeAccountCatalog(account);
	const configDir = expandTildePath(
		account.configDir || (account.credentialSource === "codex" ? join(homedir(), ".codex") : getAgentDir()),
	);
	const runtime = await ModelRuntime.create({
		credentials:
			account.credentialSource === "codex"
				? new CodexAuthStorage(configDir)
				: new ReadOnlyAuthStorage(join(configDir, "auth.json")),
		modelsPath: account.credentialSource === "codex" ? null : join(configDir, "models.json"),
		refreshOnCreate: false,
	});
	const auth = await runtime.checkAuth(account.provider);
	return {
		configDir,
		connected: !!auth,
		identity: auth?.source,
		models: runtime.getModels(account.provider).map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			authenticated: !!auth,
		})),
	};
};
