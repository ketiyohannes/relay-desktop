import { renderCode } from "../../ui/code-view.js";
import { query as $ } from "../../ui/dom.js";

/** @param {Pick<WorkspaceToolsApi, "command" | "busy" | "saved">} api */
export function installEditor(api) {
	let editor;
	let saving = false;
	let editorRequest = 0;
	const editorStatus = (refreshOnly = false) => {
		const dirty = editor && $("#editor-text").value !== editor.display;
		if (!refreshOnly)
			$("#editor-status").textContent = saving
				? "Saving…"
				: dirty
					? "Unsaved changes"
					: editor?.warning || "Saved on disk";
		$("#editor-save").disabled = !dirty || saving || api.busy();
		$("#editor-reload").disabled = saving;
	};
	/** @param {WorkspaceSelection} selection */
	const loadEditor = async (selection) => {
		const request = ++editorRequest;
		$("#editor-status").textContent = "Loading current file…";
		$("#editor-save").disabled = true;
		$("#editor-text").disabled = true;
		try {
			const file = await api.command({ type: "editor_read", ...selection, path: selection.path });
			if (request !== editorRequest) return;
			editor = { ...file, sessionId: selection.sessionId };
			$("#editor-path").textContent = file.path;
			$("#editor-text").value = file.content;
			editor.display = $("#editor-text").value;
			$("#editor-text").disabled = false;
			$("#editor-preview").hidden = true;
			$("#editor-text").hidden = false;
			$("#editor-preview-toggle").textContent = "Preview";
			editorStatus();
			$("#editor-text").focus();
		} catch (error) {
			if (request === editorRequest) $("#editor-status").textContent = error.message;
		}
	};
	const openEditor = (selection) => {
		if (!selection?.path) return;
		editor = undefined;
		$("#editor-path").textContent = selection.path;
		$("#editor-text").value = "";
		$("#editor-dialog").showModal();
		loadEditor(selection);
	};
	$("#editor-text").addEventListener("input", () => editorStatus());
	$("#editor-preview-toggle").addEventListener("click", () => {
		if (!editor) return;
		const preview = $("#editor-preview").hidden;
		$("#editor-preview").hidden = !preview;
		$("#editor-text").hidden = preview;
		$("#editor-preview-toggle").textContent = preview ? "Edit" : "Preview";
		if (preview) renderCode($("#editor-preview"), { path: editor.path, after: $("#editor-text").value }, "after");
	});
	const closeEditor = () => {
		if (saving) return;
		if (editor && $("#editor-text").value !== editor.display) {
			$("#editor-discard").hidden = false;
			return;
		}
		$("#editor-dialog").close();
	};
	$("#editor-close").addEventListener("click", closeEditor);
	$("#editor-dialog").addEventListener("cancel", (event) => {
		event.preventDefault();
		closeEditor();
	});
	$("#editor-keep").addEventListener("click", () => {
		$("#editor-discard").hidden = true;
	});
	$("#editor-discard-confirm").addEventListener("click", () => {
		$("#editor-dialog").close();
	});
	$("#editor-dialog").addEventListener("close", () => {
		editorRequest++;
		editor = undefined;
		$("#editor-discard").hidden = true;
	});
	$("#editor-reload").addEventListener("click", () => {
		if (!editor) return;
		if ($("#editor-text").value !== editor.display) {
			$("#editor-status").textContent =
				"Your draft is unsaved. Copy it before reloading, or discard and reopen this file.";
			return;
		}
		loadEditor({ sessionId: editor.sessionId, path: editor.path });
	});
	$("#editor-save").addEventListener("click", async () => {
		if (!editor || saving || api.busy()) return;
		saving = true;
		editorStatus();
		$("#editor-text").disabled = true;
		try {
			const content = editor.content.includes("\r\n")
				? $("#editor-text").value.replace(/\r?\n/g, "\r\n")
				: $("#editor-text").value;
			const file = await api.command({
				type: "editor_save",
				sessionId: editor.sessionId,
				path: editor.path,
				expected: editor.content,
				content,
			});
			editor = { ...editor, ...file, display: $("#editor-text").value };
			api.saved();
			saving = false;
			editorStatus();
		} catch (error) {
			saving = false;
			editorStatus();
			$("#editor-status").textContent = error.message;
		} finally {
			$("#editor-text").disabled = false;
		}
	});

	return { openEditor, editorStatus };
}
