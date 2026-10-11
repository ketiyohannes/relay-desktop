import type { RuntimeSelection } from "../runtimes/types.ts";

export interface DesktopAccount {
	id: string;
	name: string;
	engine: "claude" | "pi";
	/** Isolated managed profile or existing authenticated provider directory. */
	configDir: string;
	provider: string;
	model: string;
	credentialSource?: "pi" | "codex";
	/** Provider identity, independent of the local login profile and subscription plan. */
	identityKey?: string;
	/** Other profiles for the same identity, retained for shared-service selections. */
	equivalentProfiles?: string[];
	/** Complete selection for sessions discovered from another Relay frontend. */
	runtimeSelection?: RuntimeSelection;
}

export interface DesktopLogin {
	status: "running" | "success" | "error" | "cancelled";
	message: string;
	url?: string;
	code?: string;
	prompt?: {
		id: string;
		type: "text" | "secret" | "manual_code" | "select";
		message: string;
		options?: readonly { id: string; label: string; description?: string }[];
	};
}

export interface AccountCatalog {
	configDir: string;
	connected?: boolean;
	identity?: string;
	identityKey?: string;
	models: {
		provider: string;
		id: string;
		name: string;
		authenticated: boolean;
		description?: string;
		contextWindow?: number;
	}[];
}

export interface AccountCatalogs {
	accounts: { accountId: string; catalog?: AccountCatalog; error?: string }[];
}

export interface AccountUsage {
	accountId: string;
	status: "available" | "unavailable" | "unsupported";
	checkedAt: number;
	plan?: string;
	message?: string;
	noFiveHourLimit?: boolean;
	windows: { id: string; label: string; remainingPercent: number | null; resetsAt?: number }[];
}
