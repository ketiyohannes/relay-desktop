import type { DesktopTimeline } from "./timeline.ts";
import type { DesktopAction, ProjectHistory } from "./types.ts";

interface HistoryRecord {
	hash: string;
	parent?: string;
	tree: string;
	time: number;
	text: string;
}

/** Port of Timeline's tree-boundary grouping (diff-display/lua/codex_timeline/git.lua).
 * Read existing refs directly; never sync, rewrite, or install external hooks. */
export async function projectHistory(timeline: DesktopTimeline): Promise<ProjectHistory> {
	const refs = (
		await timeline.git(["for-each-ref", "--format=%(refname)", "refs/codex-timeline/", "refs/relay-timeline/"])
	)
		.trim()
		.split("\n")
		.filter(Boolean);
	const hasHead = await timeline.git(["rev-parse", "--verify", "HEAD"]).then(
		() => true,
		() => false,
	);
	const read = async (revisions: string[]): Promise<HistoryRecord[]> => {
		if (!revisions.length) return [];
		const output = await timeline.git([
			"log",
			"--topo-order",
			"--max-count=2001",
			"-z",
			"--format=%H%x1f%P%x1f%T%x1f%at%x1f%B",
			...revisions,
			"--",
		]);
		return output
			.split("\0")
			.filter(Boolean)
			.reverse()
			.map((record) => {
				const [hash, parents, tree, time, ...body] = record.split("\x1f");
				const message = body.join("\x1f");
				return {
					hash,
					parent: parents.split(" ")[0] || undefined,
					tree,
					time: Number(time) * 1000,
					text: message.split("\n")[0].replace(/^(?:codex-)?timeline:\s*/, ""),
				};
			});
	};
	const commits = await read(hasHead ? ["HEAD"] : []);
	const commitHashes = new Set(commits.map((commit) => commit.hash));
	const recorded = (await read(refs)).filter((event) => !commitHashes.has(event.hash));
	const action = (event: HistoryRecord, rootCommit: boolean): DesktopAction => ({
		id: `history:${event.hash}`,
		kind: "checkpoint",
		text: event.text,
		time: event.time,
		snapshot: event.hash,
		previous: event.parent,
		rootCommit,
	});
	const groups: ProjectHistory["groups"] = [];
	let cursor = 0;
	for (const [index, commit] of commits.entries()) {
		const boundary = recorded.findIndex((event, i) => i >= cursor && event.tree === commit.tree);
		const events =
			boundary < 0
				? []
				: recorded
						.slice(cursor, boundary + 1)
						.filter(
							(event) =>
								event.parent && !/^(?:Session baseline|baseline|existing project baseline)$/.test(event.text),
						);
		if (boundary >= 0) cursor = boundary + 1;
		groups.push({
			id: commit.hash,
			text: `#${index + 1} · ${commit.text}`,
			action: action(commit, !commit.parent),
			events: events.map((event) => action(event, false)),
		});
	}
	const pending = recorded
		.slice(cursor)
		.filter((event) => event.parent && !/^(?:Session baseline|baseline|existing project baseline)$/.test(event.text));
	groups.push({ id: "wip", text: "Uncommitted changes", events: pending.map((event) => action(event, false)) });
	for (const group of groups)
		group.events.forEach((event, index) => {
			event.changeOrder = index + 1;
		});
	return { groups, truncated: commits.length >= 2001 || recorded.length >= 2001 };
}
