export { installHistory } from "./history.js";

import { toolLabel } from "../../ui/action-label.js";
import { renderCode } from "../../ui/code-view.js";
import { query as $, button, icon, node } from "../../ui/dom.js";
import { renderFileTree } from "../../ui/file-tree.js";

/** @param {{ command: RendererCommand, openSnapshot: WorkspaceToolsApi['openSnapshot'], enabled: () => boolean }} dependencies */
export function installTimeline({ command, openSnapshot, enabled }) {
	const timelineExpansion = new Map();
	const timelineFolderExpansion = new Map();
	const timelinePreviews = new Map();
	async function renderTimelinePreview(container, sessionId, action) {
		const key = `${sessionId}/${action.id}/${action.files[0]}`;
		container.textContent = "Loading changes…";
		try {
			if (!timelinePreviews.has(key)) {
				timelinePreviews.set(key, command({ type: "snapshot", sessionId, actionId: action.id, path: action.files[0] }));
				if (timelinePreviews.size > 40) timelinePreviews.delete(timelinePreviews.keys().next().value);
			}
			const view = await timelinePreviews.get(key);
			if (container.isConnected) renderCode(container, view, "diff", { limit: 16 });
		} catch (error) {
			timelinePreviews.delete(key);
			container.textContent = error.message;
		}
	}
	/** @param {DesktopSession} session */
	function renderTimeline(session) {
		const query = $("#timeline-search").value.toLowerCase();
		const actions =
			session?.actions.filter(
				(a, index) =>
					a.displayText !== "" &&
					((a.kind === "checkpoint" && a.files?.length) || (a.kind === "review" && a.snapshot)) &&
					`${index + 1} ${a.text} ${a.files?.join(" ") || ""}`.toLowerCase().includes(query),
			) || [];
		const latestChange = actions.findLast((action) => action.kind === "checkpoint" && action.files?.length);
		const position = $("#actions").scrollTop;
		$("#actions").replaceChildren();
		if (!enabled()) return;
		if (!actions.length && query) $("#actions").append(node("p", "empty-timeline", "No matching recorded changes."));
		actions.forEach((action, index) => {
			const entry = node("article", "action");
			const details = node("details", "action-details");
			details.dataset.id = action.id;
			details.open = timelineExpansion.get(action.id) ?? action === latestChange;
			const summary = node("summary");
			let title =
				action.kind === "tool"
					? toolLabel(action)
					: action.label ||
						(action.kind === "switch" && action.text.startsWith("Imported from ")
							? "Import details"
							: action.text.split("\n")[0]);
			if (action.kind === "checkpoint" && action.files?.length)
				title = `${action.files.length} ${action.files.length === 1 ? "file" : "files"} changed`;
			if (action.kind === "tool") {
				try {
					const input = JSON.parse(action.input || "{}");
					const target = input.file_path || input.path || input.command || input.cmd || input.pattern || input.query;
					if (target) title += ` · ${target}`;
				} catch {
					/* Legacy action text remains available under details. */
				}
			}
			summary.append(
				icon(
					{
						tool: "terminal",
						checkpoint: "check-circle",
						switch: "arrows-clockwise",
						error: "warning-circle",
						review: "note-pencil",
					}[action.kind] || "code",
				),
				node("span", "action-title", title),
				node(
					"time",
					"action-time",
					new Date(action.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
				),
			);
			summary.title = `${action.kind} · Action ${index + 1} · ${title}`;
			details.append(summary);
			if (action.kind === "checkpoint" && action.files?.length) {
				const files = node("div", "timeline-files");
				if (!timelineFolderExpansion.has(action.id)) {
					timelineFolderExpansion.set(action.id, { expanded: new Set(), collapsed: new Set() });
					if (timelineFolderExpansion.size > 100)
						timelineFolderExpansion.delete(timelineFolderExpansion.keys().next().value);
				}
				renderFileTree(files, {
					files: action.files,
					changed: action.files,
					expansion: timelineFolderExpansion.get(action.id),
					select: (path) => openSnapshot(action, path),
				});
				const preview = node("pre", "timeline-preview");
				preview.setAttribute("aria-label", `Changes in ${action.files[0]}`);
				details.append(
					files,
					preview,
					button("Open code & review", () => openSnapshot(action), "timeline-review"),
				);
				summary.addEventListener("click", () => {
					timelineExpansion.set(action.id, !details.open);
					if (!details.open) renderTimelinePreview(preview, session.id, action);
				});
				// Queue until the new timeline is in the document.
				if (details.open) queueMicrotask(() => renderTimelinePreview(preview, session.id, action));
			} else {
				summary.addEventListener("click", () => timelineExpansion.set(action.id, !details.open));
				if (action.kind === "tool") {
					details.append(
						node(
							"div",
							"action-description",
							action.status === "running"
								? action.progress || "Running…"
								: action.status === "unknown"
									? "Outcome unknown"
									: action.status === "error"
										? "Failed"
										: "Completed",
						),
					);
					const raw = node("details", "action-raw");
					raw.append(
						node("summary", "", "Tool details"),
						node("pre", "", [action.input, action.output || action.text].filter(Boolean).join("\n\n")),
					);
					details.append(raw);
				} else details.append(node("div", "action-description", action.text));
			}
			if (action.snapshot) {
				const inspect = button("", () => openSnapshot(action), "icon-button action-inspect");
				inspect.append(icon("code"));
				inspect.setAttribute("aria-label", `Inspect codebase: ${title}`);
				inspect.title = "Inspect codebase and review";
				entry.append(inspect);
			}
			entry.prepend(details);
			$("#actions").append(entry);
		});
		$("#actions").scrollTop = position;
	}

	return { render: renderTimeline };
}
