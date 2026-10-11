import type { AccountCatalogLoader } from "../../../src/core/desktop/accounts.ts";
import {
	DesktopRuntime as ApplicationDesktopRuntime,
	type DesktopEngine,
	type RuntimeHost,
} from "../../../src/core/desktop/runtime.ts";

/** Preserve product regressions without starting a service or using installed accounts. */
export class DesktopRuntime extends ApplicationDesktopRuntime {
	private readonly completion: { active: boolean; promise: Promise<void>; resolve(): void };
	constructor(
		directory: string,
		host: RuntimeHost,
		engine?: DesktopEngine,
		catalog?: AccountCatalogLoader,
		roots?: { provider: "codex" | "claude"; path?: string }[],
	) {
		const completion = { active: false, promise: Promise.resolve(), resolve: () => {} };
		super(
			directory,
			{
				...host,
				state: (state) => {
					if (state.busySession && !completion.active) {
						completion.active = true;
						completion.promise = new Promise<void>((resolve) => {
							completion.resolve = resolve;
						});
					} else if (!state.busySession && completion.active) {
						completion.active = false;
						completion.resolve();
					}
					host.state(state);
				},
			},
			engine ?? (async () => {}),
			catalog,
			roots,
		);
		this.completion = completion;
	}
	/** Await the final published projection before reading or removing test data. */
	settled(): Promise<void> {
		return this.completion.promise;
	}
}
export type { DesktopEngine } from "../../../src/core/desktop/runtime.ts";
