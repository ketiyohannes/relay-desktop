import { installHistory } from "../timeline/index.js";
import { installEditor } from "./editor.js";
import { installSearch } from "./search.js";

/** @param {WorkspaceToolsApi} api */
export function installWorkspaceTools(api) {
	const search = installSearch(api);
	const editor = installEditor(api);
	const history = installHistory(api);
	return { ...search, ...editor, ...history };
}
