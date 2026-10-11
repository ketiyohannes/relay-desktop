import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";

import { dirname, resolve } from "node:path";

import { syncDirectory } from "../storage/durable.ts";

import { editorFile } from "./files.ts";
import type { EditorFile } from "./types.ts";

const maximumBytes = 2 * 1024 * 1024;

/** Compare the loaded version before replacing an existing file; never silently overwrite newer edits. */
export async function saveEditorFile(
	project: string,
	path: string,
	expected: string,
	content: string,
): Promise<EditorFile> {
	if (
		typeof expected !== "string" ||
		typeof content !== "string" ||
		Buffer.byteLength(content) > maximumBytes ||
		content.includes("\0")
	)
		throw new Error("Use a UTF-8 text file smaller than 2 MiB.");
	const current = await editorFile(project, path);
	if (current.content !== expected)
		throw new Error("File changed on disk. Reload it before saving; your draft has been kept.");
	const root = await realpath(project);
	const target = resolve(root, path);
	const temporary = resolve(dirname(target), `.relay-edit-${randomUUID()}`);
	const original = await lstat(target);
	try {
		const replacement = await open(temporary, "wx", original.mode & 0o777);
		try {
			await replacement.writeFile(content);
			await replacement.sync();
		} finally {
			await replacement.close();
		}
		const latest = await editorFile(root, path);
		const info = await lstat(target);
		if (latest.content !== expected || original.ino !== info.ino || original.dev !== info.dev)
			throw new Error("File changed on disk. Reload it before saving; your draft has been kept.");
		await rename(temporary, target);
		await syncDirectory(dirname(target));
	} finally {
		await rm(temporary, { force: true });
	}
	return { path, content };
}
