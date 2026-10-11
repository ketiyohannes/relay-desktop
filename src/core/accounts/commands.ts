import { join } from "node:path";
import { ModelRuntime } from "pi-sdk";
import type { DesktopCommand, DesktopResult } from "../desktop/protocol.ts";
import type { DesktopAction, DesktopSession, DesktopState } from "../desktop/types.ts";
import type { AccountManager } from "./accounts.ts";
import { mergeDuplicateAccounts } from "./identity.ts";
import type { DesktopLoginManager } from "./login.ts";
import { expandTildePath, getAgentDir } from "./paths.ts";
import { ReadOnlyAuthStorage } from "./readonly-credentials.ts";
import type { AccountUsageService } from "./usage.ts";

interface AccountCommandsHost {
	state(): DesktopState;
	session(id: string): DesktopSession;
	append(session: DesktopSession, action: Omit<DesktopAction, "id" | "time">): DesktopAction;
	running(): boolean;
	accounts: AccountManager;
	usage: AccountUsageService;
	login: DesktopLoginManager;
	switchRun(): void;
	publish(): Promise<void>;
	publishSelection(session: DesktopSession): Promise<void>;
	publicState(): DesktopState;
}

export async function accountCommands(
	host: AccountCommandsHost,
	command: DesktopCommand,
): Promise<DesktopResult | undefined> {
	if (command.type === "account_usage") {
		const account = host.state().accounts.find((entry) => entry.id === command.accountId);
		if (!account) throw new Error("Unknown account");
		return host.usage.read(account, command.refresh);
	}
	if (command.type === "account_catalogs") {
		const accounts = [...host.state().accounts];
		const results = await Promise.allSettled(
			accounts.map((account) => host.accounts.catalog(account, command.refresh)),
		);
		for (const [index, result] of results.entries()) {
			if (result.status === "fulfilled" && result.value.connected)
				accounts[index].identityKey = result.value.identityKey;
		}
		if (!host.running()) {
			mergeDuplicateAccounts(host.state());
			await host.publish();
		}
		return {
			accounts: results.flatMap((result, index) =>
				host.state().accounts.includes(accounts[index])
					? [
							{
								accountId: accounts[index].id,
								...(result.status === "fulfilled"
									? { catalog: result.value }
									: { error: "Connection check failed. Retry or sign in again." }),
							},
						]
					: [],
			),
		};
	}
	if (command.type === "account_catalog" || command.type === "select_model") {
		const account = host.state().accounts.find((entry) => entry.id === command.accountId);
		if (!account) throw new Error("Unknown account");
		if (command.type === "select_model" && host.running())
			throw new Error("Stop the current run before changing models");
		const previousAccount = command.type === "select_model" ? host.session(command.sessionId).accountId : undefined;
		const catalog = await host.accounts.catalog(account, command.type === "account_catalog");
		if (command.type === "account_catalog") return catalog;
		const session = host.session(command.sessionId);
		if (host.running() || session.accountId !== previousAccount || !host.state().accounts.includes(account))
			throw new Error("The active account changed. Reopen the model picker.");
		if (
			catalog.connected === false ||
			!catalog.models.some((model) => model.id === command.model && model.authenticated)
		)
			throw new Error("This model is not available for the selected account");
		if (session.accountId !== account.id || (session.models?.[account.id] ?? account.model) !== command.model) {
			session.accountId = account.id;
			session.models = { ...session.models, [account.id]: command.model };
			host.append(session, { kind: "switch", text: `Model → ${command.model} (${account.name})` });
			await host.publishSelection(session);
		}
		return host.publicState();
	}

	if (command.type === "catalog") {
		if (command.credentialSource === "codex")
			return host.accounts.load({
				id: "",
				name: "Codex",
				engine: "pi",
				provider: "openai-codex",
				model: "",
				credentialSource: "codex",
				configDir: command.configDir || "",
			});
		if (command.engine === "claude")
			return host.accounts.load({
				id: "",
				name: "Claude",
				engine: "claude",
				provider: "",
				model: "",
				configDir: command.configDir || "",
			});
		const configDir = expandTildePath(command.configDir || getAgentDir());
		const credentials = new ReadOnlyAuthStorage(join(configDir, "auth.json"));
		const stored = new Set((await credentials.list()).map((entry) => entry.providerId));
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: join(configDir, "models.json"),
			refreshOnCreate: false,
		});
		return {
			configDir,
			models: runtime.getModels().map((model) => ({
				provider: model.provider,
				id: model.id,
				name: model.name,
				authenticated: stored.has(model.provider),
			})),
		};
	}

	if (command.type === "login_start") {
		if (host.running()) throw new Error("Stop the current run before signing in");
		host.login.start(command.provider, command.name);
		return host.publicState();
	}
	if (command.type === "login_reply") {
		host.login.reply(command.id, command.value);
		return host.publicState();
	}
	if (command.type === "login_cancel") {
		await host.login.cancel();
		return host.publicState();
	}
	if (command.type === "select_account") {
		const session = host.session(command.sessionId);
		const next = host.state().accounts.find((a) => a.id === command.accountId);
		if (!next) throw new Error("Unknown account");
		if (session.accountId !== next.id) {
			const previous = host.state().accounts.find((a) => a.id === session.accountId);
			host.append(session, {
				kind: "switch",
				text: `${previous?.name || "No account"} → ${next.name} (manual)`,
			});
			if (host.state().busySession === session.id) {
				host.switchRun();
			}
		}
		session.accountId = next.id;
		session.autoSwitch = command.autoSwitch;
		await host.publishSelection(session);
		return host.publicState();
	}
	if (command.type === "move_account") {
		if (host.running()) throw new Error("Stop the current run before changing projects or accounts");
		const index = host.state().accounts.findIndex((account) => account.id === command.accountId);
		if (index < 0 || ![-1, 1].includes(command.offset)) throw new Error("Invalid account order");
		const target = index + command.offset;
		if (target >= 0 && target < host.state().accounts.length) {
			const [account] = host.state().accounts.splice(index, 1);
			host.state().accounts.splice(target, 0, account);
		}
		await host.publish();
		return host.publicState();
	}

	if (command.type === "account") {
		if (host.running()) throw new Error("Stop the current run before changing projects or accounts");
		await host.accounts.save(command.account);
		return host.publicState();
	}

	return undefined;
}
