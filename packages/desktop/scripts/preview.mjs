import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { prepareUi } from "./prepare-ui.mjs";

await prepareUi();

const ui = new URL("../ui/", import.meta.url);
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
	const name = request.url === "/" ? "index.html" : request.url?.slice(1);
	if (!["index.html", "style.css", "icons.css", "app.js", "account-controls.js", "code-view.js", "file-tree.js", "workspace-tools.js", "theme.js", "marked.js", "highlight.js", "diff.js"].includes(name) && !/^icons\/[a-z-]+\.svg$/.test(name || "")) { response.writeHead(404).end(); return; }
	try {
		const body = await readFile(fileURLToPath(new URL(name, ui)));
		response.writeHead(200, { "Content-Type": types[name.slice(name.lastIndexOf("."))] }).end(body);
	} catch { response.writeHead(500).end(); }
});
server.listen(4318, "127.0.0.1", () => console.log("Relay design preview: http://127.0.0.1:4318"));
