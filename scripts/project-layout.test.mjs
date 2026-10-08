import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { prepareUi } from "../apps/desktop/scripts/prepare-ui.mjs";
import { getWorkspacePackages } from "./package-workspaces.mjs";

test("Relay workspaces resolve without legacy source or TypeScript aliases", () => {
	assert.deepEqual(getWorkspacePackages().map(({ name }) => name), ["@relay/desktop", "@relay/core"]);
	for (const name of ["ai", "agent", "tui", "coding-agent", "app", "desktop"])
		assert.equal(existsSync(resolve("packages", name)), false);
	const config = JSON.parse(readFileSync("tsconfig.json", "utf8"));
	assert.equal(config.compilerOptions.paths, undefined);
	const manifest = JSON.parse(readFileSync("package.json", "utf8"));
	for (const name of ["start", "relay", "relay:pi", "relay:service"])
		assert.ok(existsSync(resolve(manifest.scripts[name].slice("node ".length))));
	const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
	for (const [path, entry] of Object.entries(lock.packages)) {
		assert.equal(entry.extraneous, undefined, `Stale lock entry: ${path}`);
		if (entry.link) assert.ok(manifest.workspaces.includes(entry.resolved), `Non-workspace link: ${path}`);
	}
});

test("desktop browser assets come from npm and provide highlighting, Markdown, and diffs", async () => {
	await prepareUi();
	const context = {};
	for (const asset of ["highlight.js", "marked.js", "diff.js"])
		runInNewContext(readFileSync(`apps/desktop/ui/${asset}`, "utf8"), context);
	assert.ok(context.hljs.getLanguage("typescript"));
	assert.match(context.hljs.highlight("const count = 1;", { language: "typescript" }).value, /hljs-/);
	assert.match(context.marked.parse("**Relay**"), /<strong>Relay<\/strong>/);
	assert.equal(context.Diff.diffLines("before\n", "after\n").length, 2);
	for (const name of ["highlight", "marked", "diff"])
		assert.ok(readFileSync(`apps/desktop/ui/vendor-licenses/${name}.txt`, "utf8").length);
});
