import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function getWorkspacePackages() {
	const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	return manifest.workspaces.map((path) => {
		const directory = resolve(root, path);
		return { ...JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")), directory };
	});
}
