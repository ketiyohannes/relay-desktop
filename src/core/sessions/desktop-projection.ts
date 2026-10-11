import type { DesktopAction, DesktopSession } from "../desktop/types.ts";
import { sessionChatText } from "../imports/presentation.ts";
import type { LedgerEvent } from "./types.ts";

export function publicHistory(session: DesktopSession): Extract<LedgerEvent["data"], { type: "import" }> {
	const actions = session.actions.filter(
		(action) =>
			!(
				session.importedFrom?.provider === "codex" &&
				action.time <= session.importedFrom.importedAt &&
				action.kind === "assistant" &&
				action.displayText === undefined &&
				!action.channel
			),
	);
	return {
		type: "import",
		source: `desktop:${session.id}`,
		messages: actions.flatMap((action) => {
			if (action.kind !== "user" && action.kind !== "assistant") return [];
			const text = sessionChatText(action.displayText ?? action.text, action.channel);
			return text ? [{ id: action.id, role: action.kind, text }] : [];
		}),
		outcomes: actions.flatMap((action) =>
			action.kind === "tool"
				? [
						{
							eventId: action.id,
							tool: action.text.split("\n")[0],
							outcome: action.output ?? "Outcome not recorded",
							effect: action.status === "done" ? ("completed" as const) : ("unknown" as const),
						},
					]
				: [],
		),
	};
}

export function projectEvents(session: DesktopSession, events: LedgerEvent[]): void {
	for (const entry of events) {
		const data = entry.data;
		const append = (action: Omit<DesktopAction, "id" | "time">) => {
			if (!session.actions.some((action) => action.id === entry.id))
				session.actions.push({ ...action, id: entry.id, time: entry.time });
		};
		if (data.type === "user" && !session.actions.some((action) => action.id === data.turnId))
			session.actions.push({ id: data.turnId, time: entry.time, kind: "user", text: data.text });
		if (data.type === "import")
			for (const message of data.messages)
				if (!session.actions.some((action) => action.id === message.id))
					session.actions.push({ id: message.id, time: entry.time, kind: message.role, text: message.text });
		if (data.type === "runtime" && !data.taskId) {
			const event = data.event;
			if (event.type === "text") {
				const id = `native:${data.nativeRecordId}:${event.id}`;
				let action = session.actions.find((action) => action.id === id);
				if (!action) {
					action = { id, time: entry.time, kind: "assistant", text: "", status: "running" };
					session.actions.push(action);
				}
				action.text = event.complete ? event.text : action.text + event.text;
				action.status = event.complete ? "done" : "running";
			}
			if (event.type === "tool_start" || event.type === "tool_end" || event.type === "tool_progress") {
				const id = `tool:${data.nativeRecordId}:${event.id}`;
				let action = session.actions.find((action) => action.id === id);
				if (!action) {
					action = {
						id,
						time: entry.time,
						toolId: id,
						kind: "tool",
						text: event.type === "tool_progress" ? "Tool" : event.name,
						status: "running",
					};
					session.actions.push(action);
				}
				if (event.type === "tool_start") action.input = JSON.stringify(event.input);
				if (event.type === "tool_progress") action.progress = event.text;
				if (event.type === "tool_end") {
					action.output = JSON.stringify(event.output);
					action.status = event.failed ? "error" : "done";
					action.finished = entry.time;
					delete action.progress;
				}
			}
			if (event.type === "done" && event.status !== "completed")
				append({ kind: "error", text: event.error || event.status });
			if (event.type === "done") {
				for (const action of session.actions)
					if (action.id.startsWith(`native:${data.nativeRecordId}:`) && action.status === "running")
						action.status = event.status === "completed" ? "done" : "error";
			}
		}
		if (data.type === "recovery") append({ kind: "error", text: data.description });
		if (data.type === "turn" && data.status === "unknown")
			append({
				kind: "error",
				text: `Execution ${data.turnId} is uncertain. Verify native execution and tool effects, then reconcile this Relay session before continuing.`,
			});
		if (data.type === "task") {
			const id = `task:${data.task.id}`;
			let action = session.actions.find((action) => action.id === id);
			if (!action) {
				action = { id, time: entry.time, kind: "tool", text: data.task.objective };
				session.actions.push(action);
			}
			action.text = `Delegated task (${data.task.status}): ${data.task.objective}`;
			action.status =
				data.task.status === "completed"
					? "done"
					: data.task.status === "running" || data.task.status === "blocked"
						? "running"
						: "error";
			if (data.task.result) {
				action.output = JSON.stringify(data.task.result, null, 2);
				action.finished = entry.time;
			}
		}
		if (data.type === "note") {
			const existing = session.actions.find((action) => action.id === data.note.id);
			if (existing) Object.assign(existing, data.note);
			else session.actions.push({ ...data.note, time: entry.time });
		}
	}
}
