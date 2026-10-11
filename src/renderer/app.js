import { installAccounts } from "./features/accounts/index.js";
import { installComposer } from "./features/conversation/composer.js";
import { installMessages } from "./features/conversation/messages.js";
import { mergeDesktopUpdate } from "./features/conversation/stream-state.js";
import { installSessionImport } from "./features/imports/index.js";
import { installPermissions } from "./features/permissions/index.js";
import { installReviews } from "./features/reviews/index.js";
import { installSessions } from "./features/sessions/index.js";
import { installSettings } from "./features/settings/index.js";
import { installTimeline } from "./features/timeline/index.js";
import { installSnapshotDialog } from "./features/timeline/snapshot-dialog.js";
import { installExplorer } from "./features/workspace/explorer.js";
import { installFolderPicker } from "./features/workspace/folder-picker.js";
import { installWorkspaceTools } from "./features/workspace/index.js";
import { installLayout } from "./shell/layout.js";
import { installNotices, notice } from "./shell/notices.js";
import { query as $ } from "./ui/dom.js";
import { installThemedSelects } from "./ui/select-control.js";

const bridge = window.relay;
/** @type {DesktopState} */
let state = { projects: [], sessions: [], accounts: [] };
let activeId = localStorage.getItem("relay.activeSession") || "";
let streamFrame;
const streamChanges = new Map();
/** @template {DesktopCommand} C @param {C} value @returns {Promise<DesktopCommandResult<C>>} */
async function command(value, { silent = false } = {}) {
	try {
		if (!bridge) throw new Error("Browser preview. Launch the Electron app to connect projects and accounts.");
		const result = await bridge.command(value);
		if (result && "sessions" in result && Array.isArray(result.sessions)) receive(result);
		return result;
	} catch (error) {
		if (!silent) notice(error);
		throw error;
	}
}
function active() {
	return state.sessions.find((session) => session.id === activeId);
}
function selectSession(id) {
	composer.select(activeId, id);
	explorer.reset();
	activeId = id;
	localStorage.setItem("relay.activeSession", id);
	messages.resetScroll();
	$("#notice").hidden = true;
	sessions.clearLoadError(id);
	render();
	loadActiveSession();
	if (!active()?.externalSource && active()?.project) workspaceTools.refreshHistory();
}
function receive(next) {
	cancelAnimationFrame(streamFrame);
	streamFrame = undefined;
	streamChanges.clear();
	const wasExternal = active()?.externalSource;
	state = next;
	if (!active() && state.sessions.length) {
		activeId = [...state.sessions].sort((a, b) => b.updated - a.updated)[0].id;
		localStorage.setItem("relay.activeSession", activeId);
	}
	render();
	loadActiveSession();
	if (wasExternal && !active()?.externalSource && active()?.project) workspaceTools.refreshHistory();
}
function receiveUpdate(update) {
	const busyChanged = state.busySession !== update.busySession;
	mergeDesktopUpdate(state, update);
	if (busyChanged) {
		render();
		loadActiveSession();
		return;
	}
	if (update.session.id !== activeId || !update.session.actions.length) return;
	for (const action of update.session.actions) streamChanges.set(action.id, action);
	streamFrame ??= requestAnimationFrame(() => {
		streamFrame = undefined;
		const changes = [...streamChanges.values()];
		streamChanges.clear();
		const bodies = changes.map((action) => $("#messages").querySelector(`[data-action-id="${CSS.escape(action.id)}"]`));
		if (changes.every((action, index) => action.kind === "assistant" && action.status === "running" && bodies[index])) {
			changes.forEach((action, index) => {
				bodies[index].textContent = action.displayText ?? action.text;
			});
			if (messages.following()) $("#messages").scrollTop = $("#messages").scrollHeight;
		} else renderMessages(active());
		if (changes.some((action) => action.kind === "checkpoint")) {
			renderTimeline(active());
			refreshInspector();
		}
	});
}
function render() {
	const session = active();
	if (state.persistenceError) {
		notice(state.persistenceError);
		$("#retry-save").hidden = false;
	} else $("#retry-save").hidden = true;
	const busy = !!state.busySession;
	sessions.render();
	const loading = !!session && (!!session.externalSource || session.actionsLoaded === false);
	$("#link-project").hidden = !session?.importedFrom;
	$("#link-project").disabled = busy;
	$("#import-button").disabled = busy;
	accounts.render();
	$("#auto-switch").disabled = !session || loading;
	for (const id of /** @type {const} */ (["permission-mode", "settings-permission-mode"])) {
		$(`#${id}`).value = session?.permissionMode || "ask";
		$(`#${id}`).disabled = busy || loading || !session;
	}
	$("#cancel").hidden = !busy;
	$("#send").disabled = composer.pending() || busy || loading || !session || !session.accountId;
	$("#open-project").disabled = busy;
	$("#ai-review").disabled = busy || loading || !session?.accountId;
	if (!busy) {
		permissions.clear();
	}
	renderMessages(session);
	workspaceTools.renderTimelineStatus();
	workspaceTools.editorStatus(true);
	renderTimeline(session);
	refreshInspector();
	renderSnapshotReviews();
	window.dispatchEvent(new Event("relay-select-refresh"));
}

const getState = () => state;
const getActiveId = () => activeId;
installLayout();
installNotices(command);
const settings = installSettings();
const permissions = installPermissions({ bridge, command, getActiveId, render });
const accounts = installAccounts({
	bridge,
	getState,
	getActiveId,
	active,
	command,
	notice,
	openSettings: settings.open,
	clearPermissions: permissions.clear,
});
const openAccounts = accounts.open;
const sessions = installSessions({ getState, getActiveId, active, command, selectSession, render });
const loadActiveSession = sessions.load;
const composer = installComposer({ getActiveId, command, notice, render });
const snapshot = installSnapshotDialog({
	getActiveId,
	active,
	command,
	tools: () => workspaceTools,
	renderReviews: () => reviews.render(),
});
const openSnapshot = snapshot.open;
const reviews = installReviews({
	getState,
	selection: snapshot.selection,
	actions: () => workspaceTools.actions,
	command,
	selectInspectorTab: (view) => explorer.selectTab(view),
});
const explorer = installExplorer({
	getActiveId,
	active,
	command,
	openSnapshot,
	attachOrigin: snapshot.attachOrigin,
	tools: () => workspaceTools,
	bridge,
});
const refreshInspector = explorer.refresh;
const timeline = installTimeline({ command, openSnapshot, enabled: () => workspaceTools.timelineEnabled() });
const renderTimeline = timeline.render;
const renderSnapshotReviews = reviews.render;
const messages = installMessages({
	getState,
	openAccounts,
	openSnapshot,
	loadError: sessions.loadError,
	retryLoad: sessions.retryLoad,
});
const renderMessages = messages.render;
const folders = installFolderPicker({
	command,
	bridge,
	selected: async (purpose, path) => {
		if (purpose === "project") {
			await command({ type: "project", path });
			await command({ type: "session", project: path });
			selectSession(state.sessions.at(-1).id);
		} else if (purpose === "link") {
			await command({ type: "session_project", sessionId: activeId, project: path });
			selectSession(activeId);
		} else if (purpose === "import") $("#import-project").value = path;
		else $("#account-form").elements.configDir.value = path;
	},
});
const openBrowser = folders.open;
$("#open-project").addEventListener("click", () => openBrowser("project", active()?.project));
$("#link-project").addEventListener("click", () => openBrowser("link"));
$("#browse-profile").addEventListener("click", () =>
	openBrowser("profile", $("#account-form").elements.configDir.value || undefined),
);
for (const close of document.querySelectorAll(".close-dialog"))
	close.addEventListener("click", () => close.closest("dialog").close());
document.addEventListener("pointerdown", () => {
	document.documentElement.dataset.keyboardFocus = "false";
});
document.addEventListener("keydown", (event) => {
	if (event.key === "Tab") document.documentElement.dataset.keyboardFocus = "true";
});

const workspaceTools = installWorkspaceTools({
	command,
	active,
	state: () => state,
	busy: () => !!state.busySession,
	openSnapshot,
	snapshotSelection: () => snapshot.selection(),
	renderTimeline: () => renderTimeline(active()),
	saved: () => {
		explorer.invalidate();
		workspaceTools.refreshHistory();
	},
	openSearchMatch: async (selection, match, query) => {
		if (selection.sessionId !== activeId) return;
		const action =
			active()?.actions.find((entry) => entry.id === selection.actionId) ||
			workspaceTools.actions.get(selection.actionId);
		if (selection.actionId && !action) throw new Error("Snapshot is no longer available. Refresh the timeline.");
		$("#search-dialog").close();
		await openSnapshot(action, match.path, { ...match, query });
	},
});
installThemedSelects();
installSessionImport({
	state: getState,
	busy: () => !!state.busySession,
	command,
	selectSession,
	browse: openBrowser,
	renderConversation: (result, container) =>
		renderMessages({ actions: result.actions, importedFrom: result.source }, container, 80),
});
window.addEventListener("focus", () => {
	if (bridge) command({ type: "refresh_sessions", force: false }).catch(() => {});
});
explorer.start();
if (bridge) {
	bridge.onLogin(accounts.renderLogin);
	bridge.onState(receive);
	bridge.onUpdate(receiveUpdate);
	bridge.onError(notice);
	command({ type: "state" }).catch(() => {});
} else {
	render();
}
