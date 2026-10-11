import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { expandTildePath } from "../accounts/paths.ts";
import type { DesktopCommand, DesktopResult } from "../desktop/protocol.ts";
import type { DesktopAction, DesktopSession, DesktopState } from "../desktop/types.ts";

interface SessionCommandsHost {
	state(): DesktopState;
	session(id: string): DesktopSession;
	append(session: DesktopSession, action: Omit<DesktopAction, "id" | "time">): DesktopAction;
	running(): boolean;
	saving(): boolean;
	publish(): Promise<void>;
	publishSelection(session: DesktopSession): Promise<void>;
	publicState(): DesktopState;
}

export async function sessionCommands(
	host: SessionCommandsHost,
	command: DesktopCommand,
): Promise<DesktopResult | undefined> {
	if (command.type === "session_project") {
		if (host.running() || host.saving()) throw new Error("Stop the current run before linking a folder");
		const project = await realpath(expandTildePath(command.project));
		if (!(await stat(project)).isDirectory()) throw new Error("Choose a project folder");
		if (host.running() || host.saving()) throw new Error("Stop the current run before linking a folder");
		const session = host.session(command.sessionId);
		session.project = project;
		delete session.claudeSessionId;
		delete session.lastEngine;
		if (!host.state().projects.includes(project)) host.state().projects.push(project);
		host.append(session, {
			kind: "switch",
			text: `Project folder linked: ${project}. Inspect current files before continuing.`,
		});
		await host.publishSelection(session);
		return host.publicState();
	}
	if (command.type === "project") {
		if (host.running()) throw new Error("Stop the current run before changing projects or accounts");
		const path = await realpath(command.path);
		if (!(await stat(path)).isDirectory()) throw new Error("Choose a folder");
		if (!host.state().projects.includes(path)) host.state().projects.push(path);
	}
	if (command.type === "session") {
		if (host.running()) throw new Error("Stop the current run before changing projects or accounts");
		const project = await realpath(command.project);
		if (!host.state().projects.includes(project)) throw new Error("Open the project first");
		host.state().sessions.push({
			id: randomUUID(),
			project,
			name: "Untitled session",
			updated: Date.now(),
			accountId: host.state().accounts[0]?.id ?? "",
			autoSwitch: true,
			actions: [],
		});
		await host.publishSelection(host.state().sessions.at(-1)!);
	}

	if (command.type !== "project" && command.type !== "session") return undefined;
	await host.publish();
	return host.publicState();
}
