import { execFile } from "node:child_process";

/** Display exclusions apply even if these directories were committed to Git. */
export function isChangePath(path: string): boolean {
	return !path.split(/[\\/]/).some((part) => [".git", ".github", "node_modules", ".runtime"].includes(part));
}

/** Git owns ignore matching, including nested rules, negations and global excludes. */
export async function visibleChanges(cwd: string, paths: string[]): Promise<string[]> {
	const candidates = paths.filter(isChangePath);
	if (!candidates.length) return [];
	const output = await new Promise<string>((resolve, reject) => {
		const child = execFile(
			"git",
			["check-ignore", "--no-index", "-z", "--stdin"],
			{ cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
			(error, stdout) => {
				if (error && error.code !== 1) reject(error);
				else resolve(stdout);
			},
		);
		child.stdin?.on("error", reject);
		child.stdin?.end(`${candidates.join("\0")}\0`);
	});
	const ignored = new Set(output.split("\0").filter(Boolean));
	return candidates.filter((path) => !ignored.has(path));
}
