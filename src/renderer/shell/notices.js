import { query as $, button, node } from "../ui/dom.js";
export function notice(error) {
	$("#notice").textContent = error instanceof Error ? error.message : String(error);
	$("#notice").hidden = false;
	const dialog = document.querySelector("dialog[open]");
	if (dialog) {
		let message = dialog.querySelector(".dialog-error");
		if (!message) {
			message = node("p", "dialog-error");
			dialog.append(message);
		}
		message.textContent = $("#notice").textContent;
	}
}

export function installNotices(command) {
	const retrySave = button("Retry saving", () =>
		command({ type: "retry_save" }).then(() => {
			$("#notice").hidden = true;
		}),
	);
	retrySave.id = "retry-save";
	retrySave.hidden = true;
	$("#notice").after(retrySave);

	window.addEventListener("unhandledrejection", (event) => {
		event.preventDefault();
		notice(event.reason);
	});
}
