import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let identity: Promise<string> | undefined;

/** Identify the actual installed core, including local edits and packaged builds. */
export function serviceBuild(): Promise<string> {
	identity ??= (async () => {
		const root = fileURLToPath(new URL("../", import.meta.url));
		const digest = createHash("sha256");
		digest.update(await readFile(new URL("../../../package.json", import.meta.url)));
		for (const path of (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".ts")).sort()) {
			digest.update(path);
			digest.update(await readFile(join(root, path)));
		}
		return digest.digest("hex");
	})();
	return identity;
}
