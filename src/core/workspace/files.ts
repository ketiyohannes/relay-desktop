import { execFile } from "node:child_process";

import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";

import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { isChangePath, visibleChanges } from "../timeline/change-filter.ts";
import type { SnapshotView } from "../timeline/types.ts";
import type { EditorFile } from "./types.ts";

const execute = promisify(execFile);
const maximumBytes = 2 * 1024 * 1024;

export async function editorFile(project: string, path: string): Promise<EditorFile> {
	await workspaceFile(project, path);
	const target = resolve(await realpath(project), path);
	if ((await realpath(target)) !== target || (await lstat(target)).nlink !== 1)
		throw new Error("Edit the original file, not a symbolic or hard link.");
	const bytes = await readFile(target);
	const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	if (content.includes("\0")) throw new Error("Binary files cannot be edited here.");
	return { path, content };
}

/** Resolve symlinks before reading; project browsing cannot escape its selected root. */
export async function workspaceFile(project: string, path: string): Promise<string> {
	const root = await realpath(project);
	const target = await realpath(resolve(root, path));
	const local = relative(root, target);
	if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
		throw new Error("File is outside the project");
	const info = await stat(target);
	if (!info.isFile()) throw new Error("Select a file");
	if (info.size > maximumBytes) throw new Error("File exceeds the 2 MiB viewer limit. Open it in your editor.");
	return readFile(target, "utf8");
}

export async function workspaceView(project: string, path?: string): Promise<SnapshotView> {
	const git = async (args: string[]) =>
		(await execute("git", args, { cwd: project, maxBuffer: 16 * 1024 * 1024 })).stdout;
	let files: string[];
	let changed: string[] = [];
	let repository = true;
	let hasHead = false;
	try {
		files = [
			...new Set(
				(await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean),
			),
		].sort();
		const deleted = new Set((await git(["ls-files", "--deleted", "-z"])).split("\0").filter(Boolean));
		files = files.filter((file) => !deleted.has(file));
		hasHead = !!(await git(["rev-parse", "--verify", "HEAD"]).catch(() => ""));
		changed = hasHead
			? [
					...new Set([
						...(await git(["diff", "--relative", "--name-only", "-z", "HEAD"])).split("\0"),
						...(await git(["ls-files", "-z", "--others", "--exclude-standard"])).split("\0"),
					]),
				]
					.filter(Boolean)
					.sort()
			: [...files];
	} catch {
		repository = false;
		files = [];
		const pending = [""];
		while (pending.length && files.length < 10000) {
			const local = pending.shift()!;
			for (const entry of await readdir(resolve(project, local), { withFileTypes: true })) {
				if (!isChangePath(entry.name)) continue;
				const name = local ? `${local}/${entry.name}` : entry.name;
				if (entry.isDirectory() && pending.length < 1000) pending.push(name);
				else if (entry.isFile()) files.push(name);
			}
		}
		files.sort();
	}
	changed = repository ? await visibleChanges(project, changed) : changed.filter(isChangePath);
	if (!path) return { files, changed };
	if (!files.includes(path) && !changed.includes(path)) throw new Error("File is not part of this project");
	let after = "";
	try {
		after = await workspaceFile(project, path);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const before = repository && hasHead ? await git(["show", `HEAD:./${path}`]).catch(() => "") : "";
	const diff =
		repository && hasHead
			? await git(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", path]).catch(() => "")
			: "";
	return {
		files,
		changed,
		path,
		after,
		before,
		diff: diff || (!before && after ? `New file: ${path}\n${after}` : ""),
	};
}
