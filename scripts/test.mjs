import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tests = (directory, extension) => readdirSync(new URL(`../tests/${directory}/`, import.meta.url))
	.filter((name) => name.endsWith(`.test.${extension}`)).sort().map((name) => `tests/${directory}/${name}`);

// Explicit offline categories keep node:test files out of Vitest and provider tests out of both.
for (const arguments_ of [
	["--test", ...tests("tooling", "mjs")],
	["--test", ...tests("core", "ts")],
	["node_modules/vitest/dist/cli.js", "--run", ...tests("core/desktop", "ts")],
	["--test", ...tests("renderer", "mjs")],
]) {
	const result = spawnSync(process.execPath, arguments_, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
