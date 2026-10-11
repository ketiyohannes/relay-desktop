import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { expandTildePath } from "../accounts/paths.ts";

import type { DirectoryView } from "./types.ts";

export async function browseDirectory(path?: string): Promise<DirectoryView> {
	const directory = await realpath(expandTildePath(path || homedir()));
	const entries = await readdir(directory, { withFileTypes: true });
	return {
		path: directory,
		parent: dirname(directory),
		entries: entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => ({
				name: entry.name,
				path: resolve(directory, entry.name),
				directory: true,
			}))
			.sort((a, b) => a.name.localeCompare(b.name)),
	};
}
