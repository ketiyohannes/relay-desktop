import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tests = (directory, extension, excluded = []) => {
	const files = [];
	function visit(path) {
		for (const entry of readdirSync(new URL(`../tests/${path}/`, import.meta.url), { withFileTypes: true })) {
			const child = `${path}/${entry.name}`;
			if (excluded.includes(child)) continue;
			if (entry.isDirectory()) visit(child);
			else if (entry.isFile() && entry.name.endsWith(`.test.${extension}`)) files.push(`tests/${child}`);
		}
	}
	visit(directory);
	return files.sort();
};

// Explicit offline categories keep node:test files out of Vitest and provider tests out of both.
for (const arguments_ of [
	["--test", ...tests("tooling", "mjs")],
	["--test", ...tests("core", "ts", ["core/desktop", "core/providers", "core/paid"])],
	["node_modules/vitest/dist/cli.js", "--run", ...tests("core/desktop", "ts")],
	["--test", ...tests("renderer", "mjs")],
]) {
	const result = spawnSync(process.execPath, arguments_, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
