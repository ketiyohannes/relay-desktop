import { randomUUID } from "node:crypto";

import { stat } from "node:fs/promises";
import type { DesktopState } from "../desktop/types.ts";
import type { AccountCatalogLoader } from "./catalog.ts";
import { mergeDuplicateAccounts } from "./identity.ts";
import { expandTildePath } from "./paths.ts";
import type { AccountCatalog, DesktopAccount } from "./types.ts";

interface AccountsHost {
	state(): DesktopState;
	replaceState(state: DesktopState): void;
	busy(): boolean;
	publish(): Promise<void>;
}

export class AccountManager {
	private readonly host: AccountsHost;
	readonly load: AccountCatalogLoader;
	private accountQueue: Promise<void> = Promise.resolve();
	private readonly catalogs = new Map<string, { expires: number; value: Promise<AccountCatalog> }>();
	constructor(host: AccountsHost, load: AccountCatalogLoader) {
		this.host = host;
		this.load = load;
	}
	catalog(account: DesktopAccount, refresh = false): Promise<AccountCatalog> {
		const key = JSON.stringify(account);
		const cached = this.catalogs.get(key);
		if (!refresh && cached && cached.expires > Date.now()) return cached.value;
		const value = this.load(account);
		const entry = { expires: Date.now() + 60000, value };
		this.catalogs.set(key, entry);
		void value.catch(() => {
			if (this.catalogs.get(key) === entry) this.catalogs.delete(key);
		});
		return value;
	}
	save(input: DesktopAccount): Promise<void> {
		const operation = this.accountQueue.then(async () => {
			const account = { ...input, configDir: expandTildePath(input.configDir) };
			if (!["claude", "pi"].includes(account.engine) || !account.name.trim()) throw new Error("Invalid account");
			if (account.configDir && !(await stat(account.configDir)).isDirectory())
				throw new Error("Account config directory does not exist");
			if (account.engine === "pi" && (!account.provider || !account.model))
				throw new Error("Pi needs a provider and model ID");
			if (account.credentialSource === "codex" && (account.engine !== "pi" || account.provider !== "openai-codex"))
				throw new Error("Codex credentials require Pi's openai-codex provider");
			const catalog = await this.load(account);
			if (!catalog.connected) throw new Error("No authentication found. Sign in or choose an authenticated profile.");
			if (
				!catalog.models.some(
					(model) =>
						model.id === account.model || (account.engine === "claude" && model.id === "default" && !account.model),
				)
			)
				throw new Error("Choose a model from this account's model list");
			account.configDir = catalog.configDir;
			account.identityKey = catalog.identityKey;
			if (this.host.busy()) throw new Error("Stop the current run before changing accounts");
			const before = structuredClone(this.host.state());
			const index = this.host
				.state()
				.accounts.findIndex(
					(entry) =>
						entry.id === account.id ||
						(entry.engine === account.engine &&
							entry.provider === account.provider &&
							((!!account.identityKey && entry.identityKey === account.identityKey) ||
								(!!account.configDir &&
									(entry.configDir === account.configDir || entry.equivalentProfiles?.includes(account.configDir))))),
				);
			if (index < 0) this.host.state().accounts.push({ ...account, id: randomUUID() });
			else {
				const existing = this.host.state().accounts[index];
				this.host.state().accounts[index] = {
					...account,
					id: existing.id,
					name: input.id === existing.id ? account.name : existing.name,
					equivalentProfiles: [...new Set([...(existing.equivalentProfiles || []), existing.configDir])].filter(
						(profile) => profile && profile !== account.configDir,
					),
				};
			}
			mergeDuplicateAccounts(this.host.state());
			try {
				await this.host.publish();
			} catch (error) {
				this.host.replaceState(before);
				throw error;
			}
		});
		this.accountQueue = operation.catch(() => {});
		return operation;
	}
}
