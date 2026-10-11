import { query as $, node } from "../../ui/dom.js";
import { markdown } from "../../ui/markdown.js";

/** @param {{ getState: () => DesktopState, selection: () => WorkspaceSelection | undefined, actions: () => Map<string, DesktopAction>, command: RendererCommand, selectInspectorTab: (view: string) => void }} dependencies */
export function installReviews({ getState, selection, actions, command, selectInspectorTab }) {
	function renderSnapshotReviews() {
		const container = $("#snapshot-reviews");
		container.replaceChildren();
		const session = getState().sessions.find((session) => session.id === selection()?.sessionId);
		const action =
			session?.actions.find((action) => action.id === selection()?.actionId) || actions().get(selection()?.actionId);
		if (!action?.snapshot || !session) return;
		for (const review of session.actions.filter(
			(review) => review.kind === "review" && review.snapshot === action.snapshot,
		)) {
			const details = node("details", "snapshot-review");
			details.append(
				node(
					"summary",
					"",
					`${new Date(review.time).toLocaleTimeString()} · ${review.text.split("\n")[0].slice(0, 90)}`,
				),
			);
			const body = node("div", "markdown");
			markdown(body, window.marked.lexer(review.text));
			details.append(body);
			container.append(details);
		}
	}
	$("#ai-review").addEventListener("click", async () => {
		if (!selection()?.actionId) return;
		await command({ type: "review_snapshot", ...selection(), actionId: selection().actionId });
		$("#snapshot-dialog").close();
		selectInspectorTab("timeline");
	});
	$("#review-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!selection()?.actionId) return;
		await command({
			type: "review",
			...selection(),
			actionId: selection().actionId,
			text: $("#review-text").value,
		});
		$("#review-text").value = "";
	});

	return { render: renderSnapshotReviews };
}
