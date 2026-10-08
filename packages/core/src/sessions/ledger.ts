import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { LedgerData, LedgerEvent, RelaySession } from "../contracts.ts";
import { syncDirectory } from "../storage/durable.ts";

export function project(events: LedgerEvent[]): RelaySession {
	const first = events[0];
	if (!first || first.data.type !== "created") throw new Error("Session has no creation event");
	const session: RelaySession = {
		id: first.sessionId,
		parentSessionId: first.data.parentSessionId,
		purpose: first.data.purpose,
		ephemeral: first.data.ephemeral,
		name: first.data.name,
		workspace: first.data.workspace,
		branch: "main",
		selection: first.data.selection,
		updated: first.time,
		natives: [],
		tasks: [],
		approvals: [],
		turns: [],
		events,
	};
	for (const event of events) {
		session.updated = event.time;
		const data = event.data;
		switch (data.type) {
			case "selection":
				session.selection = data.selection;
				break;
			case "workspace":
				session.workspace = data.workspace;
				session.branch = data.branch;
				break;
			case "branch":
				session.branch = data.branch;
				break;
			case "native": {
				const index = session.natives.findIndex((record) => record.id === data.record.id);
				if (index < 0) session.natives.push(data.record);
				else session.natives[index] = data.record;
				break;
			}
			case "turn": {
				const index = session.turns.findIndex((turn) => turn.id === data.turnId);
				const value = {
					id: data.turnId,
					nativeRecordId: data.nativeRecordId,
					taskId: data.taskId,
					status: data.status,
				};
				if (index < 0) session.turns.push(value);
				else session.turns[index] = value;
				break;
			}
			case "approval": {
				const index = session.approvals.findIndex((approval) => approval.id === data.approval.id);
				if (index < 0) session.approvals.push(data.approval);
				else session.approvals[index] = data.approval;
				break;
			}
			case "task": {
				const index = session.tasks.findIndex((task) => task.id === data.task.id);
				if (index < 0) session.tasks.push(data.task);
				else session.tasks[index] = data.task;
				break;
			}
			case "reconciled": {
				const turn = session.turns.find((turn) => turn.id === data.turnId);
				if (turn) {
					turn.status = "failed";
					const task = session.tasks.find((task) => task.id === turn.taskId);
					if (task) task.status = "failed";
				}
				break;
			}
		}
	}
	return session;
}

/** Recovery identities and statuses only; ephemeral conversation/tool content stays in memory. */
function recoveryMetadata(data: LedgerData): LedgerData {
	switch (data.type) {
		case "created":
			return { ...data, name: "Ephemeral session" };
		case "native":
			return { type: "native", record: { ...data.record, nativeFile: undefined } };
		case "turn":
		case "selection":
		case "workspace":
		case "manual_edit":
			return data;
		case "task":
			return { type: "task", task: { ...data.task, objective: "Ephemeral delegated task", result: undefined } };
		case "approval":
			return { type: "approval", approval: { ...data.approval, tool: "Ephemeral tool", input: {} } };
		case "reconciled":
			return { ...data, description: "Ephemeral execution reconciled" };
		case "branch":
			return { ...data, description: "Ephemeral branch" };
		default:
			return { type: "ephemeral_marker", eventType: data.type };
	}
}

/** Single service writer. Each append is synced before a runtime may execute. */
export class SessionLedger {
	readonly directory: string;
	private readonly sessions = new Map<string, LedgerEvent[]>();
	private pending: Promise<unknown> = Promise.resolve();
	private failed = false;
	constructor(directory: string) {
		this.directory = directory;
	}
	async load(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		for (const file of await readdir(this.directory)) {
			if (!file.endsWith(".jsonl")) continue;
			const path = join(this.directory, file);
			const content = await readFile(path);
			const boundary = content.lastIndexOf(10) + 1;
			// Only an incomplete final line is recoverable. Interior corruption is fatal.
			if (boundary !== content.length) {
				const backup = await open(`${path}.torn-${randomUUID()}`, "wx", 0o600);
				try {
					await backup.writeFile(content.subarray(boundary));
					await backup.sync();
				} finally {
					await backup.close();
				}
				await truncate(path, boundary);
				const repaired = await open(path, "r+");
				try {
					await repaired.sync();
				} finally {
					await repaired.close();
				}
				await syncDirectory(this.directory);
			}
			const events = content
				.subarray(0, boundary)
				.toString("utf8")
				.split("\n")
				.filter(Boolean)
				.map((line, index) => {
					const value = JSON.parse(line) as LedgerEvent;
					if (
						value.version !== 1 ||
						value.sequence !== index + 1 ||
						value.sessionId !== file.slice(0, -6) ||
						!value.data?.type
					)
						throw new Error(`Invalid journal ${file} at sequence ${index + 1}`);
					return value;
				});
			if (events.length) {
				project(events);
				this.sessions.set(file.slice(0, -6), events);
			}
		}
	}
	list(): RelaySession[] {
		return [...this.sessions.keys()].map((id) => this.get(id));
	}
	has(id: string): boolean {
		return this.sessions.has(id);
	}
	get(id: string): RelaySession {
		const events = this.sessions.get(id);
		if (!events) throw new Error("Unknown Relay session");
		return project(structuredClone(events));
	}
	forgetEphemeral(id: string): Promise<void> {
		const operation = this.pending.then(async () => {
			if (!this.get(id).ephemeral) throw new Error("Only ephemeral sessions may be forgotten");
			await rm(join(this.directory, `${id}.jsonl`));
			await syncDirectory(this.directory);
			this.sessions.delete(id);
		});
		this.pending = operation.catch(() => {});
		return operation;
	}
	append(id: string, data: LedgerData): Promise<LedgerEvent> {
		if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return Promise.reject(new Error("Invalid session ID"));
		const captured = structuredClone(data);
		const operation = this.pending.then(async () => {
			if (this.failed) throw new Error("Journal write failed; restart and reconcile before continuing");
			const events = this.sessions.get(id) ?? [];
			if (events.length === 0 && captured.type !== "created") throw new Error("Create the session first");
			if (events.length > 0 && captured.type === "created") throw new Error("Session already exists");
			const event: LedgerEvent = {
				version: 1,
				id: randomUUID(),
				sessionId: id,
				sequence: events.length + 1,
				time: Date.now(),
				data: captured,
			};
			const handle = await open(join(this.directory, `${id}.jsonl`), "a", 0o600);
			try {
				const ephemeral =
					captured.type === "created"
						? captured.ephemeral
						: events[0]?.data.type === "created" && events[0].data.ephemeral;
				await handle.writeFile(
					`${JSON.stringify(ephemeral ? { ...event, data: recoveryMetadata(captured) } : event)}\n`,
				);
				await handle.sync();
				if (!events.length) await syncDirectory(this.directory);
			} catch (error) {
				this.failed = true;
				throw error;
			} finally {
				await handle.close();
			}
			this.sessions.set(id, [...events, event]);
			return structuredClone(event);
		});
		this.pending = operation.catch(() => {});
		return operation;
	}
}
