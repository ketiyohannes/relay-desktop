import type { LedgerEvent, RelaySession } from "../contracts.ts";

/** Replay public observations only. Completed text replaces its streamed deltas. */
export function replayEvents(session: RelaySession, raw = false): LedgerEvent[] {
	const complete = new Set(
		session.events.flatMap((entry) =>
			entry.data.type === "runtime" && entry.data.event.type === "text" && entry.data.event.complete
				? [`${entry.data.nativeRecordId}:${entry.data.event.id}`]
				: [],
		),
	);
	const approvals = new Map(session.approvals.map((approval) => [approval.id, approval.status]));
	const notes = new Map(
		session.events.flatMap((entry) => (entry.data.type === "note" ? [[entry.data.note.id, entry.id] as const] : [])),
	);
	return session.events.filter((entry) => {
		const data = entry.data;
		if (data.type === "approval")
			return approvals.get(data.approval.id) === "pending" && data.approval.status === "pending";
		if (raw) return true;
		if (data.type === "note") return notes.get(data.note.id) === entry.id;
		return !(
			data.type === "runtime" &&
			data.event.type === "text" &&
			!data.event.complete &&
			complete.has(`${data.nativeRecordId}:${data.event.id}`)
		);
	});
}

export class PublicHistoryRenderer {
	readonly approvals = new Map<string, string>();
	private readonly text = new Map<string, string>();
	render(entry: LedgerEvent): string {
		const data = entry.data;
		if (data.type === "user")
			return `\n> ${data.text}${data.attachments?.length ? `\nAttachments: ${data.attachments.map((attachment) => `${attachment.description}: ${attachment.uri}`).join("\n")}` : ""}\n`;
		if (data.type === "import")
			return (
				data.messages.map((message) => `\n${message.role === "user" ? "> " : ""}${message.text}\n`).join("") +
				data.outcomes.map((outcome) => `${outcome.tool} (${outcome.effect}): ${outcome.outcome}\n`).join("") +
				(data.artifacts ?? []).map((artifact) => `${artifact.description}: ${artifact.uri}\n`).join("")
			);
		if (data.type === "note")
			return `\n${data.note.kind}${data.note.status ? ` (${data.note.status})` : ""}: ${data.note.text}${data.note.snapshot ? `\nSnapshot: ${data.note.snapshot}` : ""}\n`;
		if (data.type === "recovery" || data.type === "reconciled") return `\nRecovery: ${data.description}\n`;
		if (data.type === "manual_edit" && data.status !== "prepared")
			return `\nRelay editor ${data.status}: ${data.path}\n`;
		if (data.type === "selection")
			return `\nSelected ${data.selection.backend}: ${data.selection.model || "default"}\n`;
		if (data.type === "turn" && data.status === "unknown")
			return `\nExecution ${data.turnId} uncertain. Verify native execution and effects before reconciliation.\n`;
		if (data.type === "task")
			return `\nWorker ${data.task.id}: ${data.task.status}${data.task.result ? `\n${data.task.result.summary}` : ""}\n`;
		if (data.type === "approval") {
			if (data.approval.status !== "pending") {
				this.approvals.delete(data.approval.id);
				return "";
			}
			this.approvals.set(data.approval.id, data.approval.tool);
			return `\nApproval ${data.approval.id}: ${data.approval.tool} ${JSON.stringify(data.approval.input)}\n/allow ID or /deny ID\n`;
		}
		if (data.type !== "runtime") return "";
		const event = data.event;
		const prefix = data.taskId ? `Worker ${data.taskId}: ` : "";
		if (event.type === "text") {
			const key = `${data.nativeRecordId}:${event.id}`;
			const previous = this.text.get(key) || "";
			if (!event.complete) {
				this.text.set(key, previous + event.text);
				return prefix + event.text;
			}
			this.text.delete(key);
			return `${event.text.startsWith(previous) ? event.text.slice(previous.length) : `\n${prefix}${event.text}`}\n`;
		}
		if (event.type === "tool_start") return `\n${prefix}${event.name} ${JSON.stringify(event.input)}\n`;
		if (event.type === "tool_progress") return `${prefix}${event.text}\n`;
		if (event.type === "tool_end")
			return `${prefix}${event.name} ${event.failed ? "failed" : "completed"}: ${JSON.stringify(event.output)}\n`;
		if (event.type === "artifact") return `\n${prefix}${event.artifact.description}: ${event.artifact.uri}\n`;
		if (event.type === "compaction") return `\n${event.description}\n`;
		if (event.type === "done") return `\n${prefix}${event.status}${event.error ? `: ${event.error}` : ""}\n`;
		return "";
	}
}
