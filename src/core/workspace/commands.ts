import { relative, resolve } from "node:path";
import type { DesktopCommand, DesktopResult } from "../desktop/protocol.ts";
import type { DesktopAction, DesktopSession, DesktopState } from "../desktop/types.ts";
import { DesktopTimeline } from "../timeline/snapshots.ts";
import { browseDirectory } from "./browse.ts";
import { editorFile, workspaceView } from "./files.ts";
import { saveEditorFile } from "./save-file.ts";
import { searchCode } from "./search.ts";
import type { EditorFile } from "./types.ts";

interface WorkspaceCommandsHost {
	session(id: string): DesktopSession;
	append(session: DesktopSession, action: Omit<DesktopAction, "id" | "time">): DesktopAction;
	running(): boolean;
	saving(): boolean;
	setSaving(value: boolean): void;
	timelineAvailability: Map<string, boolean>;
	snapshotAction(session: DesktopSession, id: string): Promise<DesktopAction | undefined>;
	refreshChanges(project: string): Promise<void>;
	publish(): Promise<void>;
	publicState(): DesktopState;
	emit(state: DesktopState): void;
	saveFile?: (session: DesktopSession, path: string, expected: string, content: string) => Promise<EditorFile>;
}

export async function workspaceCommands(
	host: WorkspaceCommandsHost,
	command: DesktopCommand,
): Promise<DesktopResult | undefined> {
	if (command.type === "search_code") {
		const session = host.session(command.sessionId);
		const action = command.actionId ? await host.snapshotAction(session, command.actionId) : undefined;
		if (command.actionId && !action?.snapshot) throw new Error("Snapshot is no longer available");
		const timeline = new DesktopTimeline(session.project, session.id);
		const load = (path?: string) =>
			action?.snapshot
				? timeline.view(action.snapshot, action.previous, path, action.rootCommit)
				: workspaceView(session.project, path);
		return searchCode(await load(), load, command.query, command.scope, command.path);
	}
	if (command.type === "editor_read") {
		const session = host.session(command.sessionId);
		let path = command.path;
		if (command.actionId) {
			const action = await host.snapshotAction(session, command.actionId);
			if (!action?.snapshot) throw new Error("Unknown snapshot");
			const timeline = new DesktopTimeline(session.project, session.id);
			path = relative(session.project, resolve((await timeline.git(["rev-parse", "--show-toplevel"])).trim(), path));
		}
		return editorFile(session.project, path);
	}
	if (command.type === "editor_save") {
		if (host.running() || host.saving()) throw new Error("Wait for the current run or save to finish before saving.");
		host.setSaving(true);
		try {
			const session = host.session(command.sessionId);
			const timeline = new DesktopTimeline(session.project, session.id);
			let capturing = session.timelineEnabled ?? false;
			if (capturing)
				try {
					const baseline = await timeline.checkpoint("Before manual edit");
					if (baseline.snapshot !== baseline.previous)
						host.append(session, { kind: "checkpoint", text: "Before manual edit", ...baseline });
				} catch {
					capturing = false;
					host.timelineAvailability.set(session.project, false);
				}
			const file = host.saveFile
				? await host.saveFile(session, command.path, command.expected, command.content)
				: await saveEditorFile(session.project, command.path, command.expected, command.content);
			if (capturing) {
				try {
					const snapshot = await timeline.checkpoint(`Manual edit · ${command.path}`);
					if (snapshot.snapshot !== snapshot.previous)
						host.append(session, {
							kind: "checkpoint",
							text: `Manual edit · ${command.path}`,
							...snapshot,
						});
				} catch {
					file.warning = "Saved, but the timeline snapshot could not be recorded.";
				}
			}
			session.updated = Date.now();
			await host.refreshChanges(session.project);
			await host.publish();
			return file;
		} finally {
			host.setSaving(false);
		}
	}
	if (command.type === "browse") return browseDirectory(command.path);
	if (command.type === "workspace") {
		const project = host.session(command.sessionId).project;
		if (!command.path) {
			await host.refreshChanges(project);
			host.emit(host.publicState());
		}
		return workspaceView(project, command.path);
	}
	return undefined;
}
