import type { DesktopAction, DesktopSession } from "../desktop/types.ts";
import { snapshotAction } from "../timeline/actions.ts";
import { DesktopTimeline } from "../timeline/snapshots.ts";

export async function prepareReview(
	session: DesktopSession,
	actionId: string,
): Promise<{ review: DesktopAction; text: string; reviewDirectory: string }> {
	const review = await snapshotAction(session, actionId);
	if (!review?.snapshot) throw new Error("Review requires a snapshot");
	const timeline = new DesktopTimeline(session.project, session.id);
	const view = await timeline.view(review.snapshot, review.previous, undefined, review.rootCommit);
	const context: string[] = [];
	let bytes = 0;
	for (const path of view.changed) {
		const file = await timeline.view(review.snapshot, review.previous, path, review.rootCommit);
		const content = JSON.stringify({ path, before: file.before, after: file.after, diff: file.diff });
		bytes += content.length;
		if (bytes > 160000) throw new Error("Snapshot is too large for one review. Review a smaller checkpoint.");
		context.push(content);
	}
	const text = `Review this immutable code snapshot for concrete bugs and regressions. Cite file:line, explain the failure, and suggest a fix. Read surrounding code in the exported snapshot using read-only tools. Do not edit files. State any context limitations. Snapshot ${review.snapshot}. Full repository file list: ${JSON.stringify(view.files)}. Changed files and complete before/after contents:\n${context.join("\n")}`;
	const reviewDirectory = await timeline.exportSnapshot(review.snapshot);
	return { review, text, reviewDirectory };
}
