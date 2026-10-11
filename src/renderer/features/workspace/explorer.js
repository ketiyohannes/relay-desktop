import { renderCode } from "../../ui/code-view.js";
import { query as $ } from "../../ui/dom.js";
import { renderFileTree, updateFileTree } from "../../ui/file-tree.js";

/** @param {{ getActiveId: () => string, active: () => DesktopSession | undefined, command: RendererCommand, openSnapshot: WorkspaceToolsApi['openSnapshot'], attachOrigin: (element: HTMLElement, snapshot: string) => void, tools: () => WorkspaceController, bridge: Window['relay'] }} dependencies */
export function installExplorer({ getActiveId, active, command, openSnapshot, attachOrigin, tools, bridge }) {
	let inspectorTab = localStorage.getItem("relay.inspectorTab") || "timeline";
	if (!["timeline", "diff", "files", "code"].includes(inspectorTab)) inspectorTab = "timeline";
	let inspectorSelection = "";
	let inspectorPath = "";
	let inspectorFile;
	let inspectorRequest = 0;
	let inspectorCacheKey = "";
	function selectInspectorTab(view) {
		if (view === "diff" && inspectorFile && !inspectorFile.changed.includes(inspectorPath)) inspectorCacheKey = "";
		inspectorTab = view;
		localStorage.setItem("relay.inspectorTab", view);
		for (const tab of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-view]"))) {
			const selected = tab.dataset.view === view;
			tab.setAttribute("aria-selected", String(selected));
			tab.tabIndex = selected ? 0 : -1;
			$(`#view-${tab.dataset.view}`).hidden = !selected;
		}
		$("#inspector-source").hidden = view === "timeline";
		$("#inspector-source").open = false;
		refreshInspector();
		if (view === "timeline") tools().refreshHistory(true);
	}
	for (const tab of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-view]"))) {
		tab.addEventListener("click", () => selectInspectorTab(tab.dataset.view));
		tab.addEventListener("keydown", (event) => {
			const tabs = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-view]"))];
			if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
			event.preventDefault();
			const index =
				event.key === "Home"
					? 0
					: event.key === "End"
						? tabs.length - 1
						: (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
			selectInspectorTab(tabs[index].dataset.view);
			tabs[index].focus();
		});
	}
	async function refreshInspector() {
		const session = active();
		const snapshots = session?.actions.filter((action) => action.snapshot && action.kind === "checkpoint") || [];
		const selector = $("#inspector-snapshot");
		selector.replaceChildren();
		selector.append(new Option("Working tree", ""));
		for (const action of [...snapshots].reverse())
			selector.append(
				new Option(`${new Date(action.time).toLocaleTimeString()} · ${action.text.split("\n")[0]}`, action.id),
			);
		if (!snapshots.some((action) => action.id === inspectorSelection)) inspectorSelection = "";
		selector.value = inspectorSelection;
		selector.disabled = false;
		if (inspectorTab === "timeline") return;
		const action = snapshots.find((item) => item.id === inspectorSelection);
		const cacheKey = `${session?.id || ""}/${action?.id || `live-${session?.updated || ""}`}`;
		if (cacheKey === inspectorCacheKey) return;
		inspectorCacheKey = cacheKey;
		const request = ++inspectorRequest;
		inspectorFile = undefined;
		$("#diff-expand").disabled = true;
		$("#diff-file-title").textContent = action ? action.text.split("\n")[0] : "Working tree";
		$("#changed-files").replaceChildren();
		$("#project-files").replaceChildren();
		$("#inspector-code").textContent = session
			? "Select a file in Files or Changes."
			: "Open a project to browse files.";
		$("#inspector-diff").textContent = session ? "Loading changes…" : "Open a project to see changes.";
		$("#inspector-file-title").textContent = "Select a file";
		if (!session || session.externalSource) return;
		const selection = { sessionId: session.id, ...(action ? { actionId: action.id } : {}) };
		$("#inspector-code-mode").options[0].text = action ? "After" : "Working";
		$("#inspector-code-mode").options[1].text = action ? "Before" : "HEAD";
		try {
			const view = selection.actionId
				? await command({ type: "snapshot", ...selection, actionId: selection.actionId })
				: await command({ type: "workspace", ...selection });
			if (request !== inspectorRequest) return;
			const paths = [...new Set(selection.actionId ? [...view.files, ...view.changed] : view.files)].sort();
			renderFileTree($("#project-files"), {
				files: paths,
				changed: view.changed,
				deleted: view.changed.filter((path) => !view.files.includes(path)),
				query: $("#file-search").value,
				selected: inspectorPath,
				select: (path) => loadInspectorFile(selection, path, "code"),
			});
			renderFileTree($("#changed-files"), {
				files: view.changed,
				changed: view.changed,
				deleted: view.changed.filter((path) => !view.files.includes(path)),
				selected: inspectorPath,
				select: (path) => loadInspectorFile(selection, path, "diff"),
			});
			$("#inspector-diff").textContent = view.changed.length
				? "Select a changed file to inspect its diff."
				: "No changes in this version.";
			const path =
				inspectorTab === "diff"
					? view.changed.includes(inspectorPath)
						? inspectorPath
						: view.changed[0]
					: paths.includes(inspectorPath)
						? inspectorPath
						: view.changed[0] || paths[0];
			if (path) await loadInspectorFile(selection, path);
		} catch (error) {
			if (request === inspectorRequest) {
				inspectorCacheKey = "";
				$("#inspector-diff").textContent = String(error);
			}
		}
	}
	/** @param {WorkspaceSelection} selection */
	async function loadInspectorFile(selection, path, view = undefined) {
		const request = ++inspectorRequest;
		inspectorPath = path;
		inspectorFile = undefined;
		$("#diff-expand").disabled = true;
		$("#inspector-diff").textContent = "Loading changes…";
		$("#inspector-code").textContent = "Loading file…";
		try {
			const result = selection.actionId
				? await command({ type: "snapshot", ...selection, actionId: selection.actionId, path })
				: await command({ type: "workspace", ...selection, path });
			if (request !== inspectorRequest) return;
			inspectorFile = result;
			$("#inspector-file-title").textContent = path;
			$("#diff-file-title").textContent = path;
			$("#diff-file-title").title = path;
			$("#diff-expand").disabled = false;
			renderCode($("#inspector-diff"), result);
			renderInspectorCode();
			updateFileTree($("#project-files"), { selected: path });
			updateFileTree($("#changed-files"), { selected: path });
			if (view) selectInspectorTab(view);
		} catch (error) {
			if (request === inspectorRequest) {
				$("#inspector-diff").textContent = error.message;
				$("#inspector-code").textContent = error.message;
			}
		}
	}
	function renderInspectorCode() {
		if (!inspectorFile) return;
		renderCode($("#inspector-code"), inspectorFile, $("#inspector-code-mode").value, { attachOrigin });
	}
	$("#diff-expand").addEventListener("click", () =>
		openSnapshot(
			active()?.actions.find((action) => action.id === inspectorSelection),
			inspectorPath,
		),
	);
	$("#inspector-snapshot").addEventListener("change", () => {
		inspectorSelection = $("#inspector-snapshot").value;
		$("#inspector-source").open = false;
		refreshInspector();
	});
	$("#inspector-code-mode").addEventListener("change", renderInspectorCode);
	$("#file-search").addEventListener("input", () => {
		updateFileTree($("#project-files"), { query: $("#file-search").value });
	});
	$("#refresh-files").addEventListener("click", () => {
		inspectorCacheKey = "";
		refreshInspector();
	});
	$("#reveal-project").addEventListener("click", () => {
		if (active()) bridge.reveal(active().project);
	});
	const inspectorTarget = () => ({
		sessionId: getActiveId(),
		...(inspectorSelection ? { actionId: inspectorSelection } : {}),
		path: inspectorPath || undefined,
	});
	$("#diff-search").addEventListener("click", () => {
		if (active()) tools().openSearch(inspectorTarget(), "diff");
	});
	$("#code-search").addEventListener("click", () => {
		if (active()) tools().openSearch(inspectorTarget(), "code");
	});
	$("#inspector-edit").addEventListener("click", () => tools().openEditor(inspectorTarget()));

	return {
		refresh: refreshInspector,
		selectTab: selectInspectorTab,
		start: () => selectInspectorTab(inspectorTab),
		reset() {
			inspectorRequest++;
			inspectorCacheKey = "";
			inspectorPath = "";
			inspectorSelection = "";
		},
		invalidate() {
			inspectorCacheKey = "";
			refreshInspector();
		},
	};
}
