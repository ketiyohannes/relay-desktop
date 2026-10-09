import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
export async function prepareUi() {
	const marked = dirname(require.resolve("marked/package.json"));
	const diff = dirname(require.resolve("diff/package.json"));
	const highlight = dirname(require.resolve("@highlightjs/cdn-assets/package.json"));
	await mkdir(new URL("../src/renderer/vendor-licenses/", import.meta.url), { recursive: true });
	for (const [source, target] of [
		[join(marked, "lib/marked.umd.js"), "marked.js"],
		[join(diff, "dist/diff.js"), "diff.js"],
		[join(highlight, "highlight.min.js"), "highlight.js"],
		[join(marked, "LICENSE"), "vendor-licenses/marked.txt"],
		[join(diff, "LICENSE"), "vendor-licenses/diff.txt"],
		[join(highlight, "LICENSE"), "vendor-licenses/highlight.txt"],
	]) await copyFile(source, new URL(`../src/renderer/${target}`, import.meta.url));
}
