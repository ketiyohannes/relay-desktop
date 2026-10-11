import { readdir } from "node:fs/promises";

// Discover only UI assets under known renderer folders; skip symlinks and source declarations.
export async function previewAssets(ui) {
	const assets = new Set(["index.html", "style.css", "app.js", "marked.js", "highlight.js", "diff.js"]);
	async function visit(directory) {
		for (const entry of await readdir(new URL(`${directory}/`, ui), { withFileTypes: true })) {
			const path = `${directory}/${entry.name}`;
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile() && /\.(?:js|css|svg|woff2)$/.test(entry.name)) assets.add(path);
		}
	}
	for (const directory of ["features", "shell", "ui", "styles", "icons"]) await visit(directory);
	return assets;
}

export function previewAsset(url, assets) {
	try {
		const path = decodeURIComponent(new URL(url || "/", "http://localhost").pathname);
		const name = path === "/" ? "index.html" : path.slice(1);
		return assets.has(name) ? name : undefined;
	} catch {
		return undefined;
	}
}
