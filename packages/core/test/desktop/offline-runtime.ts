import type { AccountCatalogLoader } from "../../src/desktop/accounts.ts";
import {
	DesktopRuntime as ApplicationDesktopRuntime,
	type DesktopEngine,
	type RuntimeHost,
} from "../../src/desktop/runtime.ts";

/** Preserve product regressions without starting a service or using installed accounts. */
export class DesktopRuntime extends ApplicationDesktopRuntime {
	constructor(
		directory: string,
		host: RuntimeHost,
		engine?: DesktopEngine,
		catalog?: AccountCatalogLoader,
		roots?: { provider: "codex" | "claude"; path?: string }[],
	) {
		super(directory, host, engine ?? (async () => {}), catalog, roots);
	}
}
export type { DesktopEngine } from "../../src/desktop/runtime.ts";
