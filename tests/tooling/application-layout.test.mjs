import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { prepareUi } from "../../scripts/prepare-ui.mjs";

test("application entry points and installed dependencies resolve from one package", () => {
	const manifest = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(manifest.workspaces, undefined);
	for (const directory of ["apps", "packages", "docs", ".husky"]) assert.equal(existsSync(directory), false);
	for (const command of Object.values(manifest.scripts).filter((command) => command.startsWith("node ")))
		assert.ok(existsSync(command.slice(5)), `Missing entry: ${command}`);
	const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
	assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
	assert.deepEqual(lock.packages[""].devDependencies, manifest.devDependencies);
	for (const [path, entry] of Object.entries(lock.packages)) {
		assert.equal(entry.link, undefined, `Unexpected package link: ${path}`);
		assert.equal(entry.extraneous, undefined, `Stale package entry: ${path}`);
		assert.ok(path === "" || path.startsWith("node_modules/"), `Unexpected package path: ${path}`);
	}
});

test("browser assets provide Markdown, highlighting, and diffs with license notices", async () => {
	await prepareUi();
	const context = {};
	for (const asset of ["highlight.js", "marked.js", "diff.js"])
		runInNewContext(readFileSync(`src/renderer/${asset}`, "utf8"), context);
	assert.match(context.hljs.highlight("const count = 1;", { language: "typescript" }).value, /hljs-/);
	assert.match(context.marked.parse("**Relay**"), /<strong>Relay<\/strong>/);
	assert.equal(context.Diff.diffLines("before\n", "after\n").length, 2);
	for (const name of ["highlight", "marked", "diff"])
		assert.ok(readFileSync(`src/renderer/vendor-licenses/${name}.txt`, "utf8").length);
});
