import { query as $ } from "../../ui/dom.js";
import { matchesAppKey } from "../settings/index.js";

/** @param {{ getActiveId: () => string, command: RendererCommand, notice: (error: unknown) => void, render: () => void }} dependencies */
export function installComposer({ getActiveId, command, notice, render }) {
	const drafts = new Map();
	let pendingSend = false;
	$("#prompt").addEventListener("keydown", (event) => {
		if (event.isComposing || !matchesAppKey(event, "submit")) return;
		if ($("#send").disabled) return;
		event.preventDefault();
		$("#composer").requestSubmit();
	});
	$("#composer").addEventListener("submit", async (event) => {
		event.preventDefault();
		if (pendingSend || $("#send").disabled) return;
		const text = $("#prompt").value.trim();
		if (!text) return;
		$("#notice").hidden = true;
		const sessionId = getActiveId();
		const submitted = $("#prompt").value;
		pendingSend = true;
		$("#send").disabled = true;
		try {
			await command({ type: "prompt", sessionId, text });
			if (getActiveId() === sessionId && $("#prompt").value === submitted) $("#prompt").value = "";
			if (drafts.get(sessionId) === submitted) drafts.delete(sessionId);
		} catch (error) {
			notice(error);
		} finally {
			pendingSend = false;
			render();
		}
	});
	$("#cancel").addEventListener("click", () => command({ type: "cancel" }));
	$("#composer-caption").textContent =
		`${localStorage.getItem("relay.keybinding.submit") === "mod+enter" ? "Cmd / Ctrl + Enter" : "Enter"} to send · Shift+Enter for a new line`;

	window.addEventListener("relay-settings-change", () => {
		$("#composer-caption").textContent =
			`${localStorage.getItem("relay.keybinding.submit") === "mod+enter" ? "Cmd / Ctrl + Enter" : "Enter"} to send · Shift+Enter for a new line`;
	});

	return {
		pending: () => pendingSend,
		select(previous, next) {
			if (previous) drafts.set(previous, $("#prompt").value);
			$("#prompt").value = drafts.get(next) || "";
		},
	};
}
