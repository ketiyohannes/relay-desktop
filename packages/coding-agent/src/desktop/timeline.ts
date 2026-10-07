import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { visibleChanges } from "./change-filter.ts";
import type { SnapshotView } from "./types.ts";

const execute = promisify(execFile);

/** Isolated Git index: snapshots never change HEAD, the user's index, or working files. */
export class DesktopTimeline {
	readonly cwd: string;
	readonly ref: string;
	private pending: Promise<unknown> = Promise.resolve();
	private root?: Promise<string>;
	constructor(cwd: string, sessionId: string) {
		this.cwd = cwd;
		this.ref = `refs/relay-timeline/${sessionId}`;
	}

	async git(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
		this.root ??= execute("git", ["rev-parse", "--show-toplevel"], { cwd: this.cwd }).then((result) =>
			result.stdout.trim(),
		);
		const result = await execute("git", args, { cwd: await this.root, env, maxBuffer: 32 * 1024 * 1024 });
		return result.stdout;
	}

	async visibleChanges(paths: string[]): Promise<string[]> {
		const root = (await this.git(["rev-parse", "--show-toplevel"])).trim();
		return visibleChanges(root, paths);
	}

	checkpoint(label: string): Promise<{ snapshot: string; previous?: string; files: string[] }> {
		const operation = this.pending.then(async () => {
			// Require a repository; creating one in a user's project is an explicit user decision.
			await this.git(["rev-parse", "--show-toplevel"]);
			const directory = await mkdtemp(join(tmpdir(), "relay-index-"));
			const env = {
				...process.env,
				GIT_INDEX_FILE: join(directory, "index"),
				GIT_AUTHOR_NAME: "Relay timeline",
				GIT_AUTHOR_EMAIL: "timeline@relay.local",
				GIT_COMMITTER_NAME: "Relay timeline",
				GIT_COMMITTER_EMAIL: "timeline@relay.local",
			};
			try {
				const previous = await this.git(["rev-parse", "--verify", this.ref]).then(
					(s) => s.trim(),
					() => undefined,
				);
				await this.git(["read-tree", "--empty"], env);
				await this.git(["add", "-A", "--", ":/"], env);
				const tree = (await this.git(["write-tree"], env)).trim();
				if (previous && (await this.git(["rev-parse", `${previous}^{tree}`])).trim() === tree) {
					return { snapshot: previous, previous, files: [] };
				}
				const snapshot = (
					await this.git(["commit-tree", tree, ...(previous ? ["-p", previous] : []), "-m", label], env)
				).trim();
				await this.git(["update-ref", this.ref, snapshot, previous ?? ""]);
				const files = previous
					? (await this.git(["diff", "--name-only", "-z", previous, snapshot])).split("\0").filter(Boolean)
					: [];
				return { snapshot, previous, files: await this.visibleChanges(files) };
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		});
		this.pending = operation.catch(() => {});
		return operation;
	}

	async view(snapshot: string, previous?: string, path?: string, rootCommit = false): Promise<SnapshotView> {
		const files = (await this.git(["ls-tree", "-r", "--name-only", "-z", snapshot])).split("\0").filter(Boolean);
		const changed = await this.visibleChanges(
			previous
				? (await this.git(["diff", "--name-only", "-z", previous, snapshot])).split("\0").filter(Boolean)
				: rootCommit
					? files
					: [],
		);
		if (!path) return { files, changed };
		if (![...files, ...changed].includes(path)) throw new Error("File is not part of this snapshot");
		const after = await this.git(["show", `${snapshot}:${path}`]).catch(() => "");
		const before = previous ? await this.git(["show", `${previous}:${path}`]).catch(() => "") : "";
		const diff = previous
			? await this.git(["diff", "--no-ext-diff", "--no-textconv", "--unified=3", previous, snapshot, "--", path])
			: rootCommit
				? await this.git([
						"show",
						"--format=",
						"--no-ext-diff",
						"--no-textconv",
						"--unified=3",
						snapshot,
						"--",
						path,
					])
				: "";
		const blame =
			after && !after.includes("\0")
				? await this.git(["blame", "--line-porcelain", snapshot, "--", path]).catch(() => "")
				: "";
		const origins = blame
			.split("\n")
			.filter((line) => /^[0-9a-f]{40} \d+ \d+(?: \d+)?$/.test(line))
			.map((line) => line.split(" ")[0]);
		return { files, changed, path, after, before, diff, origins };
	}

	/** Export blobs as ordinary files: historical symlinks cannot escape the review tree. */
	async exportSnapshot(snapshot: string): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "relay-review-"));
		try {
			const entries = (await this.git(["ls-tree", "-r", "-z", snapshot])).split("\0").filter(Boolean);
			for (const entry of entries) {
				const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
				if (!match) continue;
				const target = join(directory, match[2]);
				const blob = await execute("git", ["cat-file", "blob", match[1]], {
					cwd: this.cwd,
					encoding: "buffer",
					maxBuffer: 32 * 1024 * 1024,
				});
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, blob.stdout, { mode: 0o400 });
			}
			return directory;
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	}
}
