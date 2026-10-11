import { query as $, button, icon, node } from "../../ui/dom.js";
import { positionPopover } from "./account-picker.js";
import { modelGroups } from "./model-options.js";

/** @param {{ getState: () => DesktopState, active: () => DesktopSession | undefined, command: RendererCommand, accountCatalogs: Map<string, AccountCatalog>, accountCatalogErrors: Map<string, string>, renderAccounts: () => void }} dependencies */
export function installModelPicker({
	getState,
	active,
	command,
	accountCatalogs,
	accountCatalogErrors,
	renderAccounts,
}) {
	let modelSelection;
	let modelRequest = 0;
	async function openModels(refresh = false) {
		const session = active();
		if (!session) return;
		const request = ++modelRequest;
		modelSelection = { sessionId: session.id };
		$("#model-account").textContent = "Models by provider";
		if (!$("#model-dialog").matches(":popover-open")) {
			$("#model-search").value = "";
			$("#model-dialog").showPopover();
			$("#model-search").focus();
		}
		positionPopover($("#model-dialog"), $("#model-picker"));
		$("#model-options").replaceChildren();
		$("#model-status").textContent = "Loading models…";
		$("#model-refresh").disabled = true;
		try {
			const result = await command({ type: "account_catalogs", refresh });
			if (request !== modelRequest) return;
			accountCatalogs.clear();
			accountCatalogErrors.clear();
			for (const entry of result.accounts) {
				if (entry.catalog) accountCatalogs.set(entry.accountId, entry.catalog);
				if (entry.error) accountCatalogErrors.set(entry.accountId, entry.error);
			}
			renderModelOptions();
			if ($("#settings-dialog").open) renderAccounts();
		} catch (error) {
			if (request === modelRequest) $("#model-status").textContent = `Could not load models. ${error.message}`;
		} finally {
			if (request === modelRequest) $("#model-refresh").disabled = false;
		}
	}
	function renderModelOptions() {
		const selection = modelSelection;
		if (!selection) return;
		const session = getState().sessions.find((item) => item.id === selection.sessionId);
		const search = $("#model-search").value.toLowerCase();
		$("#model-options").replaceChildren();
		let count = 0;
		for (const { provider, models, unavailable } of modelGroups(
			getState().accounts,
			accountCatalogs,
			accountCatalogErrors,
			session,
			search,
		)) {
			const group = node("section", "model-account-group");
			group.append(node("h3", "", provider));
			for (const message of unavailable) group.append(node("p", "model-account-status", message));
			count += models.length;
			for (const { model, accountId, selected } of models) {
				const row = button(
					"",
					async () => {
						row.disabled = true;
						try {
							await command({ type: "select_model", ...selection, accountId, model: model.id });
							$("#model-dialog").hidePopover();
						} catch (error) {
							$("#model-status").textContent = error.message;
						} finally {
							row.disabled = !model.authenticated;
						}
					},
					`model-option${selected ? " selected" : ""}`,
				);
				const text = node("div");
				text.append(
					node("strong", "", model.name),
					node(
						"small",
						"",
						model.description ||
							`${model.id}${model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k context` : ""}`,
					),
				);
				row.append(text, icon(selected ? "check-circle" : "caret-right"));
				row.disabled = !model.authenticated || !!getState().busySession;
				row.setAttribute("aria-pressed", String(selected));
				group.append(row);
			}
			$("#model-options").append(group);
		}
		$("#model-status").textContent = count
			? `${count} models · uses your selected account when available`
			: "No authenticated models available. Connect an account or refresh.";
	}
	$("#model-picker").addEventListener("click", () => {
		if ($("#model-dialog").matches(":popover-open")) $("#model-dialog").hidePopover();
		else openModels();
	});
	$("#model-refresh").addEventListener("click", () => openModels(true));
	$("#model-search").addEventListener("input", renderModelOptions);
	$("#model-close").addEventListener("click", () => $("#model-dialog").hidePopover());
	$("#model-dialog").addEventListener("toggle", (event) => {
		$("#model-picker").setAttribute("aria-expanded", String(event.newState === "open"));
		if (event.newState === "closed") {
			modelRequest++;
			modelSelection = undefined;
		}
	});
	window.addEventListener("resize", () => {
		if ($("#model-dialog").matches(":popover-open")) positionPopover($("#model-dialog"), $("#model-picker"));
	});

	function renderModel() {
		const session = active();
		const busy = !!getState().busySession;
		const loading = !!session && (!!session.externalSource || session.actionsLoaded === false);
		const account = getState().accounts.find((item) => item.id === session?.accountId);
		const modelId = session?.models?.[account?.id] || account?.model;
		$("#current-model").textContent =
			accountCatalogs.get(account?.id)?.models.find((item) => item.id === modelId)?.name || modelId || "Choose model";
		$("#model-picker").disabled = busy || loading || !session || !getState().accounts.length;
		$("#model-picker").title = busy ? "Stop the run before changing models" : "Choose model for this session";
		$("#composer-connect").disabled = busy;
		$("#auto-switch").checked = session?.autoSwitch ?? true;
	}
	return { render: renderModel };
}
