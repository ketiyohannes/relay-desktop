import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const core = fileURLToPath(new URL("../packages/core/", import.meta.url));
const desktop = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
for (const [directory, arguments_] of [
	[root, ["--test", ...readdirSync(new URL("./", import.meta.url)).filter((name) => name.endsWith(".test.mjs")).map((name) => `scripts/${name}`)]],
	[core, ["--test", ...readdirSync(`${core}/test`).filter((name) => name.endsWith(".test.ts")).map((name) => `test/${name}`)]],
	[core, [fileURLToPath(new URL("../node_modules/vitest/dist/cli.js", import.meta.url)), "--run", ...readdirSync(`${core}/test/desktop`).filter((name) => name.endsWith(".test.ts")).map((name) => `test/desktop/${name}`)]],
	[desktop, ["--test", ...readdirSync(`${desktop}/test`).filter((name) => name.endsWith(".test.mjs")).map((name) => `test/${name}`)]],
]) {
	const result = spawnSync(process.execPath, arguments_, { cwd: directory, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
