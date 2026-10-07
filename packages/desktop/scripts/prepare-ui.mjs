import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const agentRequire = createRequire(new URL('../../coding-agent/package.json', import.meta.url));
export async function prepareUi() {
	await copyFile(join(dirname(require.resolve("marked/package.json")), "lib/marked.umd.js"), new URL("../ui/marked.js", import.meta.url));
	// Reuse the coding agent's existing browser highlighter and diff implementation.
	await copyFile(new URL('../../coding-agent/src/core/export-html/vendor/highlight.min.js', import.meta.url), new URL('../ui/highlight.js', import.meta.url));
	await copyFile(join(dirname(agentRequire.resolve('diff/package.json')), 'dist/diff.js'), new URL('../ui/diff.js', import.meta.url));
}
