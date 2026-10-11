import type { DesktopCommand, DesktopResult } from "../desktop/protocol.ts";
import type { DesktopAction, DesktopSession } from "../desktop/types.ts";
import { projectHistory, sessionHistory } from "./history.ts";
import { DesktopTimeline } from "./snapshots.ts";

interface TimelineCommandsHost {
	session(id: string): DesktopSession;
	running(): boolean;
	saving(): boolean;
	setSaving(value: boolean): void;
	timelineAvailability: Map<string, boolean>;
	snapshotAction(session: DesktopSession, id: string): Promise<DesktopAction | undefined>;
	publish(): Promise<void>;
}

export async function timelineCommands(
	host: TimelineCommandsHost,
	command: DesktopCommand,
): Promise<DesktopResult | undefined> {
	if (command.type === "timeline_status" || command.type === "timeline_enable") {
		if (command.type === "timeline_enable" && (host.running() || host.saving()))
			throw new Error("Stop the current run before changing timeline settings");
		const session = host.session(command.sessionId);
		const timeline = new DesktopTimeline(session.project, session.id);
		const supported = await timeline.supported();
		host.timelineAvailability.set(session.project, supported);
		if (command.type === "timeline_enable") {
			if (host.running() || host.saving()) throw new Error("Stop the current run before changing timeline settings");
			host.setSaving(true);
			try {
				if (command.enabled && supported) {
					const history = await sessionHistory(timeline, session);
					session.timelineImportTruncated = history.truncated;
					for (const action of history.groups.flatMap((group) => group.events)) {
						if (
							session.actions.some(
								(existing) => existing.kind === "checkpoint" && existing.snapshot === action.snapshot,
							)
						)
							continue;
						const index = session.actions.findIndex((existing) => existing.time > action.time);
						session.actions.splice(index < 0 ? session.actions.length : index, 0, action);
					}
				}
				session.timelineEnabled = command.enabled && supported;
				await host.publish();
			} finally {
				host.setSaving(false);
			}
		}
		return {
			timeline: { supported, enabled: session.timelineEnabled ?? false },
		};
	}
	if (command.type === "history") {
		const session = host.session(command.sessionId);
		const timeline = new DesktopTimeline(session.project, session.id);
		if (!(await timeline.supported())) {
			host.timelineAvailability.set(session.project, false);
			return { groups: [], truncated: false, message: "Timeline is not supported for this project." };
		}
		if (!session.timelineEnabled)
			return { groups: [], truncated: false, message: "Import timeline to view project history." };
		try {
			return await projectHistory(timeline);
		} catch {
			return { groups: [], truncated: false, message: "Timeline is unavailable for this project." };
		}
	}

	if (command.type === "snapshot") {
		const session = host.session(command.sessionId);
		const action = await host.snapshotAction(session, command.actionId);
		if (!action?.snapshot) throw new Error("No snapshot for this action");
		const view = await new DesktopTimeline(session.project, session.id).view(
			action.snapshot,
			action.previous,
			command.path,
			action.rootCommit,
		);
		if (!command.path) {
			let events = session.actions.filter((entry) => entry.kind === "checkpoint" && entry.files?.length);
			if (action.id.startsWith("history:")) {
				const timeline = new DesktopTimeline(session.project, session.id);
				const history = await projectHistory(timeline);
				const group = history.groups.find(
					(group) => group.action?.id === action.id || group.events.some((event) => event.id === action.id),
				);
				events = group?.events || [];
				const selected = events.findIndex((event) => event.id === action.id);
				if (selected >= 0) events = events.slice(0, selected + 1);
				// Batch ref metadata stays cheap; detailed annotations are bounded for large histories.
				events = events.slice(-100);
				for (const event of events) event.files = (await timeline.view(event.snapshot!, event.previous)).changed;
			} else {
				const selected = events.findIndex((event) => event.id === action.id);
				if (selected >= 0) events = events.slice(0, selected + 1);
			}
			view.fileOrders = Object.create(null) as Record<string, number[]>;
			events.forEach((event, index) => {
				for (const path of event.files || []) {
					if (!view.changed.includes(path) && !view.files.includes(path)) continue;
					view.fileOrders![path] ??= [];
					view.fileOrders![path].push(event.changeOrder || index + 1);
				}
			});
		}
		return view;
	}
	return undefined;
}
