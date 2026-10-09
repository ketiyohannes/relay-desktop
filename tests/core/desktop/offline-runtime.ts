import type { AccountCatalogLoader } from "../../../src/core/desktop/accounts.ts";
import {
	DesktopRuntime as ApplicationDesktopRuntime,
	type DesktopEngine,
	type RuntimeHost,
} from "../../../src/core/desktop/runtime.ts";

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
export type { DesktopEngine } from "../../../src/core/desktop/runtime.ts";
