import { query as $, textElement as element } from "../../ui/dom.js";

const button = (text, click, className = "") => {
	const item = element("button", text, className);
	item.type = "button";
	item.addEventListener("click", click);
	return item;
};

/** @param {Pick<WorkspaceToolsApi, "command" | "openSearchMatch">} api */
export function installSearch(api) {
	let searchRequest = 0;
	let searchTimer;
	/** @type {WorkspaceSelection} */
	let searchSelection;
	let matches = [];
	let matchIndex = -1;
	const openMatch = async (index) => {
		if (!matches.length) return;
		matchIndex = (index + matches.length) % matches.length;
		const match = matches[matchIndex];
		$("#search-count").textContent = `${matchIndex + 1} / ${matches.length}`;
		for (const [i, item] of [...$("#search-results").children].entries())
			item.classList.toggle("selected", i === matchIndex);
		await api.openSearchMatch(searchSelection, match, $("#code-search-query").value, $("#code-search-scope").value);
	};
	const search = async () => {
		const request = ++searchRequest;
		const query = $("#code-search-query").value;
		matches = [];
		matchIndex = -1;
		$("#search-results").replaceChildren();
		$("#search-count").textContent = query ? "Searching…" : "";
		$("#search-prev").disabled = $("#search-next").disabled = true;
		if (!query || !searchSelection) return;
		const { path, ...selection } = searchSelection;
		try {
			const result = await api.command({
				type: "search_code",
				...selection,
				query,
				scope: $("#code-search-scope").value === "diff" ? "diff" : "code",
				...($("#code-search-files").value === "file" && path ? { path } : {}),
			});
			if (request !== searchRequest) return;
			matches = result.matches;
			$("#search-count").textContent =
				`${matches.length} matching lines${result.truncated ? " · search limit reached" : ""}${result.skipped ? ` · ${result.skipped} files skipped` : ""}`;
			matches.forEach((match, index) => {
				const row = button("", () => openMatch(index), `search-result ${match.kind}`);
				row.append(
					element("strong", `${match.path}:${match.line} · ${match.side === "before" ? "before" : "after"}`),
					element("span", match.text),
				);
				$("#search-results").append(row);
			});
			$("#search-prev").disabled = $("#search-next").disabled = !matches.length;
		} catch (error) {
			if (request === searchRequest) $("#search-count").textContent = error.message;
		}
	};
	/** @param {WorkspaceSelection} selection */
	const openSearch = (selection, scope) => {
		searchRequest++;
		searchSelection = selection;
		$("#code-search-scope").value = scope;
		$("#code-search-files").value = "all";
		$("#search-target").textContent = selection.actionId ? "Selected snapshot" : "Working tree";
		if (!$("#search-dialog").open) $("#search-dialog").showModal();
		$("#code-search-query").focus();
		search();
	};
	$("#code-search-query").addEventListener("input", () => {
		searchRequest++;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(search, 200);
	});
	for (const id of ["#code-search-scope", "#code-search-files"]) $(id).addEventListener("change", search);
	$("#search-prev").addEventListener("click", () => openMatch(matchIndex - 1));
	$("#search-next").addEventListener("click", () => openMatch(matchIndex + 1));
	$("#search-dialog").addEventListener("close", () => {
		searchRequest++;
		clearTimeout(searchTimer);
	});

	return { openSearch };
}
