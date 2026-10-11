import { toolLabel } from "../../ui/action-label.js";
import { renderCode } from "../../ui/code-view.js";
import { query as $, button, icon, node } from "../../ui/dom.js";
import { markdown } from "../../ui/markdown.js";

/** @param {{ getState: () => DesktopState, openAccounts: (tab?: string) => void, openSnapshot: WorkspaceToolsApi['openSnapshot'], loadError: (id: string) => string | undefined, retryLoad: (id: string) => void }} dependencies */
export function installMessages({ getState, openAccounts, openSnapshot, loadError, retryLoad }) {
	let followMessages = true;
	const toolExpansion = new Map();
	const activityExpansion = new Map();
	const messageBodies = new Map();
	const messageLimits = new Map();
	/** @param {Partial<DesktopSession>} session */
	function renderMessages(session, container = $("#messages"), limit = Infinity) {
		const position = container.scrollTop;
		container.replaceChildren();
		const visible =
			session?.actions.filter((action) => {
				if (
					action.displayText === "" ||
					(action.label && action.displayText === undefined) ||
					["analysis", "justify", "confidence"].includes(action.channel)
				)
					return false;
				if (action.kind === "checkpoint") return !!action.files?.length;
				if (
					action.kind === "switch" &&
					session.importedFrom &&
					(action.time <= session.importedFrom.importedAt || action.text.startsWith("Imported from "))
				)
					return false;
				return true;
			}) || [];
		const windowSize = messageLimits.get(session?.id) || 100;
		const actions = container === $("#messages") ? visible.slice(-windowSize) : visible.slice(0, limit);
		if (container === $("#messages") && visible.length > windowSize)
			container.append(
				button("Load earlier messages", () => {
					messageLimits.set(session.id, windowSize + 100);
					followMessages = false;
					renderMessages(session);
				}),
			);
		if (!actions.length) {
			const welcome = node("div", "welcome");
			if (session?.externalSource || session?.actionsLoaded === false) {
				const error = loadError(session.id);
				welcome.append(
					node("h2", "", error ? "Could not open conversation" : "Loading conversation…"),
					node("p", "", error || "Reading the local transcript. Messages and tool calls will appear here."),
				);
				if (error)
					welcome.append(
						button("Retry", () => {
							retryLoad(session.id);
						}),
					);
				container.append(welcome);
				return;
			}
			welcome.append(
				node("h2", "", session ? "Start a conversation" : "Open a project"),
				node(
					"p",
					"",
					session
						? "Choose an account and send a prompt. Tool calls and code changes will appear as your agent works."
						: "Add a folder from the Projects panel, then connect an account to begin.",
				),
			);
			if (!getState().accounts.length)
				welcome.append(button("Connect an account", () => openAccounts("connect"), "welcome-connect"));
			container.append(welcome);
			return;
		}
		let activity;
		let activityActions = [];
		let previousMessage;
		const progressIds = new Set();
		let turn = [];
		const collectProgress = () => {
			if (!turn.some((action) => ["tool", "checkpoint"].includes(action.kind))) return;
			const lastReply = turn.findLast((action) => action.kind === "assistant");
			for (const action of turn)
				if (action.kind === "assistant" && action !== lastReply && action.status !== "running")
					progressIds.add(action.id);
		};
		for (const action of actions) {
			if (action.kind === "user") {
				collectProgress();
				turn = [];
			}
			turn.push(action);
		}
		collectProgress();
		const finishActivity = () => {
			if (!activity) return;
			const tools = activityActions.filter((action) => action.kind === "tool");
			const running = tools.findLast((action) => action.status === "running");
			const failed = tools.some((action) => action.status === "error");
			const summary = node("summary");
			const changes = new Set(activityActions.flatMap((action) => action.files || []));
			const count = tools.length;
			const label = running
				? toolLabel(running)
				: count
					? `Worked · ${count} ${count === 1 ? "action" : "actions"}`
					: `${changes.size} ${changes.size === 1 ? "file" : "files"} changed`;
			summary.append(icon("caret-right"), node("span", "", label));
			if (running || failed)
				summary.append(
					node("small", running ? "activity-running" : "activity-error", running ? "Running" : "Needs attention"),
				);
			else if (count && changes.size)
				summary.append(node("small", "", `${changes.size} ${changes.size === 1 ? "file" : "files"} changed`));
			const group = activity;
			summary.addEventListener("click", () => activityExpansion.set(group.dataset.id, !group.open));
			activity.prepend(summary);
			activity = undefined;
			activityActions = [];
		};
		for (const action of actions) {
			if (action.kind === "user" || action.kind === "error" || action.kind === "switch") finishActivity();
			if (["tool", "checkpoint"].includes(action.kind) || progressIds.has(action.id)) {
				if (!activity) {
					activity = node("details", "conversation-work");
					activity.dataset.id = action.id;
					activity.open = activityExpansion.get(action.id) ?? false;
					container.append(activity);
				}
				activityActions.push(action);
				previousMessage = undefined;
			}
			if (progressIds.has(action.id)) {
				const note = node("div", "work-note markdown");
				if (window.marked) markdown(note, window.marked.lexer(action.displayText ?? action.text));
				else note.textContent = action.displayText ?? action.text;
				activity.append(note);
			} else if (action.kind === "tool") {
				const details = node("details", `tool-card ${action.status || "done"}`);
				details.dataset.id = action.id;
				details.open = toolExpansion.get(action.id) ?? false;
				const summary = node("summary");
				summary.addEventListener("click", () => toolExpansion.set(action.id, !details.open));
				const name = toolLabel(action);
				summary.title = action.text.split("\n")[0];
				let input = {};
				try {
					input = JSON.parse(action.input || "{}") || {};
				} catch {
					/* Preserve raw input below. */
				}
				const target =
					input.command ||
					input.cmd ||
					input.file_path ||
					input.path ||
					input.pattern ||
					input.query ||
					input.description ||
					(typeof input === "string" ? input.split("\n")[0] : "");
				const unknownOutcome =
					action.status === "unknown" ||
					(action.toolId?.startsWith("import:") && action.status === "error" && !action.finished);
				const status =
					action.status === "running"
						? action.progress || "Running"
						: unknownOutcome
							? "Outcome unknown"
							: action.status === "unknown"
								? "Outcome unknown"
								: action.status === "error"
									? "Failed"
									: "Completed";
				const title = node("span", "tool-heading");
				title.append(node("span", "tool-name", name), node("span", "tool-target", String(target)));
				summary.append(
					icon("caret-right"),
					icon(name.includes("command") ? "terminal" : "code"),
					title,
					node(
						"span",
						"tool-state",
						`${status}${action.finished && action.finished > action.time ? ` · ${((action.finished - action.time) / 1000).toFixed(1)}s` : ""}`,
					),
				);
				details.append(summary);
				const renderBody = () => {
					if (details.querySelector(".tool-body")) return;
					const body = node("div", "tool-body");
					if (action.input) {
						let display = action.input;
						try {
							display = JSON.stringify(JSON.parse(display), null, 2);
						} catch {
							/* Raw patch/command input remains readable. */
						}
						const content = node("pre");
						renderCode(content, { path: "input.json", after: display }, "after");
						body.append(
							node("div", "tool-section-label", `Input${action.provider ? ` · ${action.provider}` : ""}`),
							content,
						);
					}
					const output = action.output ?? action.text.split("\n").slice(1).join("\n");
					if (output) {
						let display = output;
						try {
							const value = JSON.parse(output);
							if (typeof value === "string") display = value;
							else if (Array.isArray(value?.content))
								display =
									value.content
										.filter((item) => item.type === "text")
										.map((item) => item.text)
										.join("\n") || output;
							if (value?.details?.diff) display += `\n${value.details.diff}`;
						} catch {
							/* Plain tool output is displayed verbatim. */
						}
						body.append(node("div", "tool-section-label", "Output"), node("pre", "tool-output", display));
					} else
						body.append(
							node("p", "tool-waiting", action.status === "running" ? "Waiting for output…" : "No output returned."),
						);
					details.append(body);
				};
				if (details.open) renderBody();
				summary.addEventListener("click", () => {
					if (!details.open) renderBody();
				});
				activity.append(details);
			} else if (action.kind === "checkpoint") {
				const checkpoint = button("", () => openSnapshot(action), "conversation-checkpoint");
				checkpoint.append(
					icon("check-circle"),
					node("span", "", action.files.length === 1 ? action.files[0] : `${action.files.length} files changed`),
					node("span", "muted", "View changes"),
				);
				activity.append(checkpoint);
			} else {
				const provider = action.provider || "Agent";
				const continuing = action.kind === "assistant" && previousMessage?.dataset.provider === provider;
				const message = continuing ? previousMessage : node("article", `message ${action.kind}`);
				if (!continuing) {
					message.dataset.provider = provider;
					message.title = new Date(action.time).toLocaleString();
					if (["user", "assistant", "review"].includes(action.kind)) {
						const label = node(
							"div",
							action.kind === "user" ? "sr-only" : "message-label",
							action.kind === "user" ? "You" : action.kind === "review" ? `${provider} · Review` : provider,
						);
						message.append(label);
					}
				}
				const text = action.displayText ?? action.text;
				const key = `${session?.id || "preview"}/${action.id}`;
				const cached = messageBodies.get(key);
				let body;
				if (cached?.text === text && cached.status === action.status) body = cached.body;
				else {
					body = node("div", "message-body");
					body.dataset.actionId = action.id;
					if (["user", "assistant", "review"].includes(action.kind) && window.marked && action.status !== "running") {
						body.classList.add("markdown");
						markdown(body, window.marked.lexer(text));
					} else body.textContent = text;
					messageBodies.set(key, { text, status: action.status, body });
					if (messageBodies.size > 300) messageBodies.delete(messageBodies.keys().next().value);
				}
				message.append(body);
				if (!continuing) container.append(message);
				previousMessage = action.kind === "assistant" ? message : undefined;
			}
		}
		finishActivity();
		if (visible.length > limit)
			container.append(node("p", "muted", "Open the session to read the rest of this conversation."));
		if (session?.id && getState().busySession === session.id) {
			const activity = node("div", "conversation-activity");
			activity.append(
				node("span", "led"),
				node(
					"span",
					"",
					session.actions.some((action) => action.kind === "tool" && action.status === "running")
						? "Working on your request"
						: "Agent is responding…",
				),
			);
			container.append(activity);
		}
		container.scrollTop = container === $("#messages") && followMessages ? container.scrollHeight : position;
	}
	$("#messages").addEventListener("scroll", () => {
		const box = $("#messages");
		followMessages = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
	});

	return {
		render: renderMessages,
		resetScroll: () => {
			followMessages = true;
		},
		following: () => followMessages,
	};
}
