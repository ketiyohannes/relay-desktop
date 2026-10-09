import { homedir } from "node:os";
import { join } from "node:path";
import { type Options, type Query, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ModelRuntime } from "pi-sdk";
import { ReadOnlyAuthStorage } from "../accounts/readonly-credentials.ts";
import { type CodexTransport, StdioCodexTransport } from "../runtimes/codex/transport.ts";
import { expandTildePath, getAgentDir } from "./config.ts";
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
			identityKey: info.email ? JSON.stringify([info.email.trim().toLowerCase(), info.organization || ""]) : undefined,
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
	if (account.provider === "openai-codex") return codexAccountCatalog(account);
	const configDir = expandTildePath(
		account.configDir || (account.credentialSource === "codex" ? join(homedir(), ".codex") : getAgentDir()),
	);
	const runtime = await ModelRuntime.create({
		credentials: new ReadOnlyAuthStorage(join(configDir, "auth.json")),
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

export async function codexAccountCatalog(
	account: DesktopAccount,
	connect: (profile: string) => Pick<CodexTransport, "request" | "notify" | "close"> = (profile) =>
		new StdioCodexTransport(profile),
): Promise<AccountCatalog> {
	const configDir = expandTildePath(account.configDir || process.env.CODEX_HOME || join(homedir(), ".codex"));
	const transport = connect(configDir);
	try {
		await transport.request("initialize", { clientInfo: { name: "relay", version: "0.0.3" } });
		transport.notify("initialized");
		const identity = (await transport.request("account/read", { refreshToken: false })) as {
			account?: { email?: string; planType?: string; type?: string };
		};
		const connected = !!identity.account;
		const models: AccountCatalog["models"] = [];
		let cursor: string | null = null;
		do {
			const response = (await transport.request("model/list", { cursor, limit: 100 })) as {
				data: { id: string; model: string; displayName: string; description: string }[];
				nextCursor: string | null;
			};
			models.push(
				...response.data.map((model) => ({
					provider: "openai-codex",
					id: model.model,
					name: model.displayName,
					description: model.description,
					authenticated: connected,
				})),
			);
			cursor = response.nextCursor;
		} while (cursor);
		return {
			configDir,
			connected,
			identity: [identity.account?.email, identity.account?.planType].filter(Boolean).join(" · "),
			identityKey: identity.account?.email?.trim().toLowerCase() || undefined,
			models,
		};
	} finally {
		await transport.close();
	}
}
