import { query as $ } from "../../ui/dom.js";

/** @param {{ bridge: Window['relay'], command: RendererCommand, getActiveId: () => string, render: () => void }} dependencies */
export function installPermissions({ bridge, command, getActiveId, render }) {
	const permissionQueue = [];
	function showPermission() {
		const request = permissionQueue[0];
		if (!request) return;
		$("#permission-title").textContent = `Allow ${request.tool}?`;
		$("#permission-input").textContent = JSON.stringify(request.input, null, 2);
		if (!$("#permission-dialog").open) $("#permission-dialog").showModal();
	}
	async function answerPermission(allowed, allowRun = false) {
		const request = permissionQueue.shift();
		$("#permission-dialog").close();
		if (request) await bridge.permission(request.id, allowed, allowRun);
		showPermission();
	}
	$("#permission-allow").addEventListener("click", () => answerPermission(true));
	$("#permission-run").addEventListener("click", () => answerPermission(true, true));
	$("#permission-deny").addEventListener("click", () => answerPermission(false));
	$("#permission-dialog").addEventListener("cancel", (event) => {
		event.preventDefault();
		answerPermission(false);
	});
	for (const id of /** @type {const} */ (["permission-mode", "settings-permission-mode"]))
		$(`#${id}`).addEventListener("change", async () => {
			try {
				await command({
					type: "session_permissions",
					sessionId: getActiveId(),
					mode: /** @type {DesktopSession['permissionMode']} */ ($(`#${id}`).value),
				});
			} catch {
				render();
			}
		});

	function clear() {
		permissionQueue.length = 0;
		$("#permission-dialog").close();
	}
	if (bridge) {
		bridge.onPermission((request) => {
			permissionQueue.push(request);
			showPermission();
		});
		bridge.onPermissionClosed((id) => {
			const index = permissionQueue.findIndex((request) => request.id === id);
			if (index < 0) return;
			permissionQueue.splice(index, 1);
			if (index === 0) {
				$("#permission-dialog").close();
				showPermission();
			}
		});
	}

	return { clear };
}
