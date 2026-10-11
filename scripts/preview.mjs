import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { prepareUi } from "./prepare-ui.mjs";
import { previewAssets, previewAsset } from "./preview-assets.mjs";

await prepareUi();

const ui = new URL("../src/renderer/", import.meta.url);
const assets = await previewAssets(ui);
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = createServer(async (request, response) => {
	const name = previewAsset(request.url, assets);
	if (!name) { response.writeHead(404).end(); return; }
	try {
		const body = await readFile(fileURLToPath(new URL(name, ui)));
		response.writeHead(200, { "Content-Type": types[name.slice(name.lastIndexOf("."))] }).end(body);
	} catch { response.writeHead(404).end(); }
});
server.listen(4318, "127.0.0.1", () => console.log("Relay design preview: http://127.0.0.1:4318"));
