import type { AccountCatalogLoader } from "../../src/desktop/accounts.ts";

/** Synthetic auth/catalog for engine tests; never inspect the developer's credentials. */
export const fakeAccountCatalog: AccountCatalogLoader = async (account) => ({
	configDir: account.configDir,
	connected: true,
	models: [{ provider: account.provider, id: account.model, name: "Test model", authenticated: true }],
});
