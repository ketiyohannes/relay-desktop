import type { DesktopAccount, DesktopState } from "./types.ts";

/** Merge presentation accounts without deleting provider credentials or conversation history. */
export function mergeDuplicateAccounts(state: DesktopState): void {
	const accounts: DesktopAccount[] = [];
	for (const account of state.accounts) {
		const existing = accounts.find(
			(entry) =>
				entry.engine === account.engine &&
				entry.provider === account.provider &&
				((!!entry.identityKey && entry.identityKey === account.identityKey) ||
					(!!entry.configDir &&
						(entry.configDir === account.configDir || entry.equivalentProfiles?.includes(account.configDir)))),
		);
		if (!existing) {
			accounts.push(account);
			continue;
		}
		existing.identityKey ??= account.identityKey;
		existing.equivalentProfiles = [
			...new Set([...(existing.equivalentProfiles || []), account.configDir, ...(account.equivalentProfiles || [])]),
		].filter((profile) => profile && profile !== existing.configDir);
		for (const session of state.sessions) {
			if (session.accountId === account.id) {
				session.accountId = existing.id;
				session.models = { ...session.models, [existing.id]: session.models?.[account.id] ?? account.model };
			} else if (session.models?.[account.id] && !session.models[existing.id]) {
				session.models[existing.id] = session.models[account.id];
			}
			if (session.models) delete session.models[account.id];
		}
	}
	state.accounts = accounts;
}
