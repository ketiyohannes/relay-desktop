import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { prepareUi } from "../apps/desktop/scripts/prepare-ui.mjs";

const root = new URL("../", import.meta.url);
const ui = new URL("apps/desktop/ui/", root);
await prepareUi();
const html = await readFile(new URL("index.html", ui), "utf8");
for (const [, asset] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
	if (!asset.startsWith("http")) await access(new URL(asset, ui));
}
await build({
	entryPoints: [fileURLToPath(new URL("app.js", ui))],
	bundle: true,
	platform: "browser",
	format: "esm",
	write: false,
});
for (const [entry, format] of [["main.ts", "esm"], ["preload.ts", "cjs"]]) {
	await build({
		entryPoints: [fileURLToPath(new URL(`apps/desktop/src/${entry}`, root))],
		bundle: true,
		platform: "node",
		format,
		external: ["electron"],
		write: false,
	});
}
console.log("Desktop renderer assets and Electron entry points resolve.");
