import { query as $, button, icon, node } from "../../ui/dom.js";

/** @param {{ getState: () => DesktopState, getActiveId: () => string, active: () => DesktopSession | undefined, command: RendererCommand, selectSession: (id: string) => void, render: () => void }} dependencies */
export function installSessions({ getState, getActiveId, active, command, selectSession, render }) {
	const sessionLoads = new Map();
	const sessionLoadErrors = new Map();
	function loadActiveSession() {
		const session = active();
		if (
			!session ||
			(!session.externalSource && session.actionsLoaded !== false) ||
			sessionLoads.has(session.id) ||
			sessionLoadErrors.has(session.id)
		)
			return;
		const id = session.id;
		sessionLoads.set(
			id,
			command({ type: "session_load", sessionId: id })
				.catch((error) => {
					sessionLoadErrors.set(id, error.message);
				})
				.finally(() => {
					sessionLoads.delete(id);
					render();
				}),
		);
	}

	function sessionOrigin(session) {
		return session.importedFrom?.provider === "codex"
			? "Codex"
			: session.importedFrom?.provider === "claude"
				? "Claude"
				: "Relay";
	}
	const projectExpansion = new Map();
	function renderSessions() {
		const session = active();
		const busy = !!getState().busySession;
		const query = $("#session-search").value.trim().toLowerCase();
		const discovery = getState().sessionDiscovery;
		$("#session-discovery").textContent = discovery?.refreshing
			? "Finding local sessions…"
			: discovery?.warnings.length
				? discovery.warnings.join("\n")
				: "";
		$("#session-discovery").hidden = !$("#session-discovery").textContent;
		$("#projects").replaceChildren();
		for (const project of getState().projects) {
			const sessions = getState()
				.sessions.filter(
					(s) =>
						s.project === project &&
						`${s.name} ${project} ${s.importedFrom?.provider || ""} ${s.importedFrom?.sessionId || ""}`
							.toLowerCase()
							.includes(query),
				)
				.sort((a, b) => b.updated - a.updated);
			if (query && !sessions.length) continue;
			const group = node("details", "project");
			group.open = !!query || (projectExpansion.get(project) ?? project === session?.project);
			const heading = node("summary", "project-name");
			heading.addEventListener("click", () => {
				if (!query) projectExpansion.set(project, !group.open);
			});
			const name = node("span", "project-title", project.split(/[\\/]/).at(-1) || "Unlinked sessions");
			name.title = project;
			heading.append(
				icon("folder-open"),
				name,
				button("", async (event) => {
					event.preventDefault();
					event.stopPropagation();
					await command({ type: "session", project });
					selectSession(getState().sessions.at(-1).id);
				}),
			);
			heading.querySelector("button").setAttribute("aria-label", `New session in ${project}`);
			heading.querySelector("button").classList.add("icon-button");
			heading.querySelector("button").append(icon("plus"));
			heading.querySelector("button").disabled = busy || !project;
			group.append(heading);
			for (const item of sessions) {
				const entry = button(
					item.name,
					() => selectSession(item.id),
					`session-button${item.id === getActiveId() ? " selected" : ""}`,
				);
				entry.title = `${item.name}${item.importedFrom ? ` · ${item.importedFrom.provider === "claude" ? "Claude" : "Codex"}` : ""}`;
				entry.setAttribute("aria-current", item.id === getActiveId() ? "true" : "false");
				const copy = node("span", "session-copy");
				const updated = new Date(item.updated).toLocaleDateString([], { month: "short", day: "numeric" });
				copy.append(
					node("span", "session-name", item.name),
					node("small", "session-meta", `${sessionOrigin(item)} · ${updated}`),
				);
				entry.replaceChildren(icon("chat-circle"), copy);
				group.append(entry);
			}
			$("#projects").append(group);
		}
		if (!getState().projects.length)
			$("#projects").append(node("p", "empty-timeline", "Your projects live here.\nOpen a folder with +."));
		$("#recent").replaceChildren();
		const recent = [...getState().sessions].sort((a, b) => b.updated - a.updated).slice(0, 4);
		for (const item of recent) {
			const entry = button(item.name, () => selectSession(item.id));
			entry.append(node("small", "", `${sessionOrigin(item)} · ${item.project.split(/[\\/]/).at(-1) || "Unlinked"}`));
			$("#recent").append(entry);
		}
		if (!recent.length) $("#recent").append(node("small", "eyebrow", "NO SESSIONS YET"));
		$("#session-title").textContent = session?.name || "New session";
		$("#project-path").textContent = session
			? `${sessionOrigin(session)} · ${session.project || "Link a project folder to continue"}`
			: "Open a project to begin";
	}
	$("#session-search").addEventListener("input", render);

	return {
		render: renderSessions,
		load: loadActiveSession,
		loadError: (id) => sessionLoadErrors.get(id),
		clearLoadError: (id) => sessionLoadErrors.delete(id),
		retryLoad(id) {
			sessionLoadErrors.delete(id);
			loadActiveSession();
			render();
		},
	};
}
