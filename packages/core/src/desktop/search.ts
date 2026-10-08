import { structuredPatch } from "diff";
import type { CodeSearchResult, SnapshotView } from "./types.ts";

export async function searchCode(
	view: SnapshotView,
	load: (path: string) => Promise<SnapshotView>,
	query: string,
	scope: "diff" | "code",
	path?: string,
): Promise<CodeSearchResult> {
	const result: CodeSearchResult = { matches: [], truncated: false, skipped: 0 };
	if (!query || query.length > 500) return result;
	const needle = query.toLowerCase();
	const available = scope === "diff" ? view.changed : [...new Set([...view.files, ...view.changed])];
	const paths = path ? available.filter((item) => item === path) : available;
	const deadline = Date.now() + 5000;
	let bytes = 0;
	for (const [index, filePath] of paths.entries()) {
		if (index >= 500 || bytes > 8 * 1024 * 1024 || Date.now() > deadline) {
			result.truncated = true;
			break;
		}
		let file: SnapshotView;
		try {
			file = await load(filePath);
		} catch {
			result.skipped++;
			continue;
		}
		const before = file.before || "";
		const after = file.after || "";
		bytes += before.length + after.length;
		if (before.includes("\0") || after.includes("\0")) {
			result.skipped++;
			continue;
		}
		const patch = structuredPatch(filePath, filePath, before, after, undefined, undefined, {
			context: scope === "code" ? Infinity : 0,
			timeout: 100,
		});
		if (!patch) {
			result.skipped++;
			continue;
		}
		const hunks = patch.hunks.length
			? patch.hunks
			: scope === "code"
				? [{ oldStart: 1, newStart: 1, lines: after.split("\n").map((line) => ` ${line}`) }]
				: [];
		for (const hunk of hunks) {
			let oldLine = hunk.oldStart;
			let newLine = hunk.newStart;
			for (const line of hunk.lines) {
				if (line.startsWith("\\")) continue;
				const removed = line[0] === "-";
				const number = removed ? oldLine : newLine;
				if (line[0] !== "+") oldLine++;
				if (!removed) newLine++;
				if (!line.slice(1).toLowerCase().includes(needle)) continue;
				result.matches.push({
					path: filePath,
					line: number,
					side: removed ? "before" : "after",
					text: line.slice(1),
					kind: removed ? "removed" : line[0] === "+" ? "added" : "context",
				});
				if (result.matches.length >= 200) {
					result.truncated = true;
					return result;
				}
			}
		}
	}
	return result;
}
