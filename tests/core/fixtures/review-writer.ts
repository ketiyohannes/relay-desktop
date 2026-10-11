import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { DesktopStore } from "../../../src/core/desktop/store.ts";
import { ProcessLock } from "../../../src/core/storage/process-lock.ts";

const [mode, directory, project] = process.argv.slice(2);
if (mode === "store") {
	const store = new DesktopStore(directory);
	await store.load();
	process.send?.({ type: "ready" });
	process.on("message", () => {
		store.state.projects.push(project);
		void store.save().then(
			() => {
				process.send?.({ type: "saved" });
				process.disconnect?.();
			},
			(error: unknown) => {
				process.send?.({ type: "error", message: String(error) });
				process.disconnect?.();
			},
		);
	});
} else {
	const rename = fs.rename;
	if (mode === "pause-claim" || mode === "pause-recovery") {
		process.on("message", () => {});
		mock.method(fs, "rename", async (from: string, to: string) => {
			if ((mode === "pause-claim" && to === directory) || (mode === "pause-recovery" && from === directory)) {
				process.send?.({ type: "paused" });
				await new Promise<void>(() => {});
			}
			return rename(from, to);
		});
		syncBuiltinESMExports();
	}
	try {
		const lock = await ProcessLock.acquire(directory);
		process.send?.({ type: "owned" });
		process.on("message", () => {
			void lock.release().then(() => process.disconnect?.());
		});
	} catch (error) {
		process.send?.({ type: "error", message: String(error) });
		process.disconnect?.();
	}
}
