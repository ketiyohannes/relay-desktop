import { renderCode } from "../../ui/code-view.js";
import { query as $, button } from "../../ui/dom.js";
import { renderFileTree, updateFileTree } from "../../ui/file-tree.js";

/** @param {{ getActiveId: () => string, active: () => DesktopSession | undefined, command: RendererCommand, tools: () => WorkspaceController, renderReviews: () => void }} dependencies */
export function installSnapshotDialog({ getActiveId, active, command, tools, renderReviews }) {
	/** @type {WorkspaceSelection} */
	let selectedSnapshot;
	let fileView;
	let snapshotRequest = 0;
	/** @param {DesktopAction} [action] */
	async function openSnapshot(action = undefined, preferredPath = undefined, searchMatch = undefined) {
		const request = ++snapshotRequest;
		selectedSnapshot = { sessionId: getActiveId(), ...(action ? { actionId: action.id } : {}) };
		tools().updateNavigation();
		renderReviews();
		fileView = undefined;
		$("#snapshot-title").textContent = action ? action.text.split("\n")[0] : "Working tree";
		$("#snapshot-dialog .eyebrow").textContent = action
			? "Historical codebase · Read only"
			: "Working tree · Read only";
		$("#review-form").hidden = !action;
		$("#code-mode").options[0].text = action ? "Entire file / after" : "Entire file / working";
		$("#code-mode").options[1].text = action ? "Entire file / before" : "Entire file / HEAD";
		$("#file-title").textContent = "Changes";
		$("#snapshot-all-files").checked = false;
		$("#snapshot-all-files").disabled = true;
		$("#snapshot-file-search").value = "";
		$("#snapshot-edit").disabled = true;
		$("#snapshot-files").replaceChildren();
		$("#file-content").textContent = "Loading snapshot…";
		if (!$("#snapshot-dialog").open) $("#snapshot-dialog").showModal();
		const selection = { ...selectedSnapshot };
		const view = selection.actionId
			? await command({ type: "snapshot", ...selection, actionId: selection.actionId })
			: await command({ type: "workspace", ...selection });
		if (request !== snapshotRequest) return;
		const paths = [...new Set([...view.changed, ...view.files])];
		const showAll = !!preferredPath && !view.changed.includes(preferredPath);
		$("#snapshot-all-files").checked = showAll;
		$("#snapshot-all-files").disabled = false;
		const load = async (path) => {
			const fileRequest = ++snapshotRequest;
			fileView = undefined;
			$("#file-content").textContent = "Loading file…";
			$("#file-title").textContent = path;
			updateFileTree($("#snapshot-files"), { selected: path });
			try {
				const result = selection.actionId
					? await command({ type: "snapshot", ...selection, actionId: selection.actionId, path })
					: await command({ type: "workspace", ...selection, path });
				if (fileRequest !== snapshotRequest) return;
				fileView = result;
				$("#snapshot-edit").disabled = false;
				renderFile();
			} catch (error) {
				if (fileRequest === snapshotRequest) $("#file-content").textContent = error.message;
			}
		};
		renderFileTree($("#snapshot-files"), {
			files: paths,
			changed: view.changed,
			deleted: view.changed.filter((path) => !view.files.includes(path)),
			changedOnly: !showAll,
			select: load,
			orders: view.fileOrders,
		});
		const path = paths.includes(preferredPath) ? preferredPath : view.changed[0];
		$("#code-mode").value = searchMatch ? "context" : view.changed.includes(path) ? "diff" : "after";
		if (path) await load(path);
		else $("#file-content").textContent = "No visible changes. Enable All files to browse the codebase.";
		if (searchMatch && fileView?.path === path) {
			renderCode($("#file-content"), fileView, "context", { attachOrigin, query: searchMatch.query });
			const row = [.../** @type {NodeListOf<HTMLElement>} */ ($("#file-content").querySelectorAll(".code-line"))].find(
				(row) => row.dataset[searchMatch.side === "before" ? "oldLine" : "newLine"] === String(searchMatch.line),
			);
			row?.classList.add("active-match");
			row?.scrollIntoView({ block: "center" });
		}
	}
	$("#snapshot-all-files").addEventListener("change", () => {
		updateFileTree($("#snapshot-files"), { changedOnly: !$("#snapshot-all-files").checked });
		if (!$("#snapshot-all-files").checked && fileView && !fileView.changed.includes(fileView.path)) {
			snapshotRequest++;
			fileView = undefined;
			$("#file-content").textContent = "Select a changed file.";
			$("#file-title").textContent = "Changes";
		}
	});
	$("#snapshot-file-search").addEventListener("input", () =>
		updateFileTree($("#snapshot-files"), { query: $("#snapshot-file-search").value }),
	);
	$("#snapshot-dialog").addEventListener("close", () => {
		snapshotRequest++;
		fileView = undefined;
	});
	function renderFile() {
		if (!fileView) return;
		$("#file-title").textContent = fileView.path;
		renderCode($("#file-content"), fileView, $("#code-mode").value, { attachOrigin });
	}
	function attachOrigin(element, snapshot) {
		const recorded =
			active()?.actions.filter((action) => action.snapshot && action.kind === "checkpoint" && action.files?.length) ||
			[];
		const action =
			recorded.find((action) => action.snapshot === snapshot) ||
			[...tools().actions.values()].find((action) => action.snapshot === snapshot);
		element.dataset.origin = snapshot;
		element.title = action
			? `Origin: ${action.text} · ${new Date(action.time).toLocaleTimeString()}`
			: `Origin: ${snapshot.slice(0, 8)}`;
		if (action) {
			const index = recorded.indexOf(action);
			const badge = button(
				action.changeOrder ? `Δ${action.changeOrder}` : index >= 0 ? `Δ${index + 1}` : "Origin",
				() => openSnapshot(action),
				"origin-badge",
			);
			badge.title = element.title;
			element.append(badge);
			element.querySelector(".line-number").addEventListener("click", () => openSnapshot(action));
		}
	}
	$("#code-mode").addEventListener("change", renderFile);
	$("#snapshot-search").addEventListener("click", () =>
		tools().openSearch(
			{ ...selectedSnapshot, path: fileView?.path },
			$("#code-mode").value === "diff" ? "diff" : "code",
		),
	);
	$("#snapshot-edit").addEventListener("click", () =>
		tools().openEditor({ ...selectedSnapshot, path: fileView?.path }),
	);

	return { open: openSnapshot, attachOrigin, selection: () => selectedSnapshot };
}
