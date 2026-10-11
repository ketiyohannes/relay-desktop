import { query as $, button, icon, node } from "../../ui/dom.js";

/** @param {{ command: RendererCommand, bridge: Window['relay'], selected: (purpose: string, path: string) => Promise<void> }} dependencies */
export function installFolderPicker({ command, bridge, selected }) {
	let directoryView;
	let browserPurpose = "project";
	let browserRequest = 0;
	async function openBrowser(purpose, path) {
		browserPurpose = purpose;
		$("#browser-title").textContent =
			purpose === "project" ? "Open project" : purpose === "profile" ? "Select account profile" : "Link project folder";
		$("#browser-select").textContent = purpose === "project" ? "Open folder" : "Use folder";
		$("#browser-search").value = "";
		$("#browser-dialog").showModal();
		await loadDirectory(path);
	}
	async function loadDirectory(path) {
		const request = ++browserRequest;
		directoryView = undefined;
		$("#browser-select").disabled = true;
		$("#browser-finder").disabled = true;
		$("#browser-entries").replaceChildren(node("p", "empty-timeline", "Loading folders…"));
		const result = await command({ type: "browse", path });
		if (request !== browserRequest) return;
		directoryView = result;
		$("#browser-select").disabled = false;
		$("#browser-finder").disabled = false;
		$("#browser-path").value = result.path;
		$("#browser-up").disabled = result.parent === result.path;
		renderDirectory();
	}
	function renderDirectory() {
		$("#browser-entries").replaceChildren();
		for (const entry of directoryView?.entries || []) {
			const search = $("#browser-search").value.toLowerCase();
			if (entry.name.startsWith(".") && !search.startsWith(".")) continue;
			if (!entry.name.toLowerCase().includes(search)) continue;
			const row = button(entry.name, () => {
				$("#browser-search").value = "";
				loadDirectory(entry.path);
			});
			row.prepend(icon("folder-open"));
			$("#browser-entries").append(row);
		}
		if (!$("#browser-entries").children.length)
			$("#browser-entries").append(node("p", "empty-timeline", "No matching folders."));
	}
	$("#browser-path-form").addEventListener("submit", (event) => {
		event.preventDefault();
		loadDirectory($("#browser-path").value);
	});
	$("#browser-search").addEventListener("input", renderDirectory);
	$("#browser-up").addEventListener("click", () => {
		$("#browser-search").value = "";
		loadDirectory(directoryView.parent);
	});
	$("#browser-finder").addEventListener("click", () => bridge.reveal(directoryView.path));
	$("#browser-select").addEventListener("click", async () => {
		if (!directoryView) return;
		const path = directoryView.path;
		await selected(browserPurpose, path);
		$("#browser-dialog").close();
	});

	return { open: openBrowser };
}
