import type { RuntimeSelection } from "../runtimes/types.ts";

import type { DesktopAccount } from "./types.ts";

export function accountSelection(account: DesktopAccount): RuntimeSelection {
	if (account.runtimeSelection) return { ...account.runtimeSelection, model: account.model };
	if (account.engine === "claude") return { backend: "claude", profile: account.configDir, model: account.model };
	if (account.provider === "openai-codex")
		return { backend: "codex", profile: account.configDir, model: account.model };
	return { backend: "pi", profile: account.configDir, model: account.model, options: { provider: account.provider } };
}
