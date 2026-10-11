import { query as $, button, icon, node } from "../../ui/dom.js";
import { installAccountControls } from "./account-picker.js";
import { installModelPicker } from "./model-picker.js";

/** @param {{ getState: () => DesktopState, getActiveId: () => string, active: () => DesktopSession | undefined, command: RendererCommand, notice: (error: unknown) => void, openSettings: (page?: string) => void, clearPermissions: () => void, bridge: Window['relay'] }} dependencies */
export function installAccounts({
	getState,
	getActiveId,
	active,
	command,
	notice,
	openSettings,
	clearPermissions,
	bridge,
}) {
	const accountCatalogs = new Map();
	const accountCatalogErrors = new Map();
	let editingAccount = "";
	let loginState;
	function selectAccountTab(selected) {
		for (const tab of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-account-tab]"))) {
			const active = tab.dataset.accountTab === selected;
			tab.setAttribute("aria-selected", String(active));
			tab.tabIndex = active ? 0 : -1;
			$(`#account-view-${tab.dataset.accountTab}`).hidden = !active;
		}
		if (selected === "profile") $("#accounts-panel .existing-profiles").open = true;
	}
	function openAccounts(tab = getState().accounts.length ? "connected" : "connect") {
		accountForm();
		renderAccounts();
		selectAccountTab(loginState?.status === "running" ? "connect" : tab);
		openSettings("accounts");
	}
	for (const tab of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-account-tab]"))) {
		tab.addEventListener("click", () => selectAccountTab(tab.dataset.accountTab));
		tab.addEventListener("keydown", (event) => {
			if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
			event.preventDefault();
			const tabs = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-account-tab]"))];
			const index =
				event.key === "Home"
					? 0
					: event.key === "End"
						? tabs.length - 1
						: (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
			selectAccountTab(tabs[index].dataset.accountTab);
			tabs[index].focus();
		});
	}
	for (const provider of /** @type {const} */ (["codex", "claude"]))
		$(`#signup-${provider}`).addEventListener("click", async () => {
			await bridge.openUrl(provider === "codex" ? "https://chatgpt.com/auth/login" : "https://claude.ai/login");
			$("#signup-status").textContent =
				`Create your ${provider === "codex" ? "ChatGPT" : "Claude"} account in the browser, then return and choose Sign in to connect it to Relay.`;
		});
	function renderLogin(next) {
		loginState = next;
		const running = next.status === "running";
		$("#login-codex").disabled = running;
		$("#login-claude").disabled = running;
		$("#login-name").disabled = running;
		for (const provider of /** @type {const} */ (["codex", "claude"])) $(`#signup-${provider}`).disabled = running;
		$("#login-cancel").hidden = !running;
		$("#login-status").textContent = next.message;
		$("#login-steps").replaceChildren();
		if (next.url) $("#login-steps").append(button("Open authorization page", () => bridge.openUrl(next.url)));
		if (next.code) $("#login-steps").append(node("p", "login-code", next.code));
		if (next.prompt) {
			const prompt = next.prompt;
			$("#login-steps").append(node("p", "", prompt.message));
			if (prompt.options) {
				for (const option of prompt.options)
					$("#login-steps").append(
						button(option.label, () => command({ type: "login_reply", id: prompt.id, value: option.id })),
					);
			} else {
				const input = node("input");
				input.type = prompt.type === "secret" ? "password" : "text";
				input.autocomplete = "off";
				input.setAttribute("aria-label", prompt.message);
				const submit = () => {
					const value = input.value.trim();
					if (value) {
						input.value = "";
						command({ type: "login_reply", id: prompt.id, value });
					}
				};
				input.addEventListener("keydown", (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						submit();
					}
				});
				$("#login-steps").append(input, button("Continue", submit));
			}
		}
		if (next.status === "success") {
			accountCatalogs.clear();
			renderAccounts();
			$("#login-steps").append(button("View connected accounts", () => selectAccountTab("connected")));
			const session = active();
			if (session && !session.accountId && getState().accounts.length)
				command({
					type: "select_account",
					sessionId: session.id,
					accountId: getState().accounts.at(-1).id,
					autoSwitch: true,
				});
		}
	}
	for (const provider of /** @type {const} */ (["codex", "claude"]))
		$(`#login-${provider}`).addEventListener("click", () =>
			command({
				type: "login_start",
				provider,
				name: $("#login-name").value.trim() || (provider === "codex" ? "Codex" : "Claude"),
			}),
		);
	$("#login-cancel").addEventListener("click", () => {
		$("#login-status").textContent = "Cancelling sign-in…";
		command({ type: "login_cancel" });
	});
	$("#settings-dialog").addEventListener("close", () => {
		if (loginState?.status === "running") command({ type: "login_cancel" });
	});
	let accountRequest = 0;
	/** @param {Partial<DesktopAccount>} [account] */
	function accountForm(account) {
		$("#accounts-panel .existing-profiles").open = !!account;
		if (account) selectAccountTab("profile");
		accountRequest++;
		editingAccount = account?.id || "";
		const form = $("#account-form");
		form.reset();
		$("#profile-status").textContent = "";
		for (const name of ["name", "engine", "configDir", "provider", "model", "credentialSource"])
			if (account) form.elements[name].value = account[name] || (name === "credentialSource" ? "pi" : "");
		renderAccountFields();
	}
	function renderAccountFields() {
		const form = $("#account-form");
		const pi = form.elements.engine.value === "pi";
		form.elements.credentialSource.closest("label").hidden = !pi;
		form.elements.provider.closest("label").hidden = !pi;
		$("#load-models").hidden = false;
		if (!pi) form.elements.credentialSource.value = "pi";
	}
	$("#account-form").elements.engine.addEventListener("change", renderAccountFields);
	function renderAccounts() {
		$("#configured-accounts").replaceChildren();
		if (!getState().accounts.length)
			$("#configured-accounts").textContent = "No accounts connected. Add profiles in fallback order.";
		for (const [index, account] of getState().accounts.entries()) {
			const row = node("article", "connected-account");
			const heading = node("div", "connected-heading");
			const identity = node("div");
			const provider =
				account.engine === "claude" ? "Claude" : account.provider === "openai-codex" ? "Codex" : account.provider;
			const catalog = accountCatalogs.get(account.id);
			identity.append(
				node("strong", "", account.name),
				node("small", "", `${provider} · ${account.model || "Default model"}`),
			);
			const status = node(
				"span",
				"connection-status",
				accountCatalogErrors.has(account.id)
					? "Unavailable"
					: catalog
						? catalog.connected
							? `${catalog.models.filter((model) => model.authenticated).length} models`
							: "Sign-in needed"
						: "Saved",
			);
			heading.append(identity, status);
			row.append(heading);
			if (catalog?.identity) row.append(node("p", "account-identity", catalog.identity));
			accountControls.attachUsage(row, account);
			const controls = node("div", "account-row-controls");
			const use = button(active()?.accountId === account.id ? "Selected" : "Use account", async () => {
				if (active())
					await command({
						type: "select_account",
						sessionId: getActiveId(),
						accountId: account.id,
						autoSwitch: $("#auto-switch").checked,
					});
				renderAccounts();
			});
			use.disabled = !active() || active()?.accountId === account.id;
			const check = button("Check connection", async () => {
				check.disabled = true;
				status.textContent = "Checking…";
				try {
					accountCatalogs.set(account.id, await command({ type: "account_catalog", accountId: account.id }));
					accountCatalogErrors.delete(account.id);
					renderAccounts();
				} catch {
					status.textContent = "Check failed";
					check.disabled = false;
				}
			});
			controls.append(
				use,
				check,
				button("Edit", () => accountForm(account)),
			);
			const up = button("", async () => {
				await command({ type: "move_account", accountId: account.id, offset: -1 });
				renderAccounts();
			});
			up.append(icon("arrow-up"));
			up.setAttribute("aria-label", `Move ${account.name} earlier in fallback order`);
			up.disabled = index === 0;
			controls.append(up);
			const down = button("", async () => {
				await command({ type: "move_account", accountId: account.id, offset: 1 });
				renderAccounts();
			});
			down.append(icon("arrow-up"));
			down.className = "move-account-down";
			down.title = "Move later";
			down.setAttribute("aria-label", `Move ${account.name} later in fallback order`);
			down.disabled = index === getState().accounts.length - 1;
			controls.append(down);
			row.append(controls);
			$("#configured-accounts").append(row);
		}
	}
	$("#composer-connect").addEventListener("click", () => openAccounts("connect"));
	$("#new-account").addEventListener("click", () => {
		accountForm();
		$("#accounts-panel .existing-profiles").open = true;
	});
	let catalog;
	async function loadModels() {
		const form = $("#account-form");
		const request = ++accountRequest;
		const provider = form.elements.provider.value;
		$("#profile-status").textContent = "Loading profile models…";
		catalog = await command({
			type: "catalog",
			configDir: form.elements.configDir.value || undefined,
			credentialSource: form.elements.credentialSource.value === "codex" ? "codex" : "pi",
			engine: form.elements.engine.value === "claude" ? "claude" : "pi",
		});
		if (request !== accountRequest) return;
		$("#models-list").replaceChildren();
		for (const model of catalog.models.filter(
			(model) => form.elements.engine.value === "claude" || !provider || model.provider === provider,
		))
			$("#models-list").append(new Option(`${model.name} / ${model.provider}`, model.id));
		const authenticated = [
			...new Set(catalog.models.filter((model) => model.authenticated).map((model) => model.provider)),
		];
		$("#profile-status").textContent = authenticated.length
			? `Credentials available · ${catalog.models.length} models loaded${catalog.identity ? ` · ${catalog.identity}` : ""}`
			: "No credentials found. Sign in from Add account, or choose another profile.";
		return catalog;
	}
	$("#load-models").addEventListener("click", loadModels);
	$("#account-form").elements.provider.addEventListener("change", loadModels);
	async function useDefaultPi(source) {
		accountForm({
			id: "",
			name: source === "codex" ? "Codex" : "Pi",
			engine: "pi",
			configDir: "",
			provider: "openai-codex",
			model: "",
			credentialSource: source,
		});
		const result = await loadModels();
		if (!result) return;
		$("#account-form").elements.configDir.value = result.configDir;
		const preferred = result.models.filter((model) => model.authenticated && model.provider === "openai-codex");
		const chosen = preferred.at(-1);
		if (chosen) $("#account-form").elements.model.value = chosen.id;
	}
	$("#default-pi").addEventListener("click", () => useDefaultPi("pi"));
	$("#default-codex").addEventListener("click", () => useDefaultPi("codex"));
	$("#default-claude").addEventListener("click", () => {
		accountForm({ id: "", name: "Claude", engine: "claude", configDir: "", provider: "", model: "sonnet" });
		loadModels();
	});
	$("#account-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		const form = $("#account-form");
		const fields = form.elements;
		try {
			await command({
				type: "account",
				account: {
					id: editingAccount,
					name: fields.name.value,
					engine: fields.engine.value === "claude" ? "claude" : "pi",
					configDir: fields.configDir.value,
					provider: fields.provider.value,
					model: fields.model.value,
					credentialSource: fields.credentialSource.value === "codex" ? "codex" : "pi",
				},
			});
			accountCatalogs.clear();
			const session = active();
			if (session && !session.accountId)
				await command({
					type: "select_account",
					sessionId: session.id,
					accountId: getState().accounts.at(-1).id,
					autoSwitch: true,
				});
			renderAccounts();
			selectAccountTab("connected");
			form.reset();
		} catch (error) {
			notice(error);
		}
	});
	async function updateAccount(accountId = active()?.accountId) {
		if (!active()) return;
		if (getState().busySession === getActiveId() && active().accountId !== accountId) {
			clearPermissions();
		}
		await command({
			type: "select_account",
			sessionId: getActiveId(),
			accountId,
			autoSwitch: $("#auto-switch").checked,
		});
	}
	$("#auto-switch").addEventListener("change", () => updateAccount());
	window.addEventListener("relay-settings-page", (event) => {
		if (!(event instanceof CustomEvent)) return;
		if (event.detail !== "accounts") return;
		renderAccounts();
		if (!document.querySelector('[data-account-tab][aria-selected="true"]'))
			selectAccountTab(loginState?.status === "running" || !getState().accounts.length ? "connect" : "connected");
	});

	const accountControls = installAccountControls({
		state: getState,
		active,
		command,
		openAccounts,
		choose: updateAccount,
	});
	const models = installModelPicker({
		getState,
		active,
		command,
		accountCatalogs,
		accountCatalogErrors,
		renderAccounts,
	});
	window.addEventListener("relay-settings-change", () => accountControls.render());

	return {
		open: openAccounts,
		renderLogin,
		renderAccounts,
		render() {
			accountControls.render();
			models.render();
		},
	};
}
