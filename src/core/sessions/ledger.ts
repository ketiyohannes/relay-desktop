import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { LedgerData, LedgerEvent, RelaySession } from "../contracts.ts";
import { syncDirectory } from "../storage/durable.ts";
import { validateLedgerEvent } from "./validation.ts";

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
	for (const event of events) applyEvent(session, event);
	return session;
}

function applyEvent(session: RelaySession, event: LedgerEvent): void {
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
			if (index < 0) session.tasks.push({ ...data.task });
			else session.tasks[index] = { ...data.task };
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
	private readonly projections = new Map<string, RelaySession>();
	private readonly edits = new Map<string, Map<string, string>>();
	private readonly workspaces = new Map<string, Set<string>>();
	private readonly sizes = new Map<string, number[]>();
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
					let value: LedgerEvent;
					try {
						value = validateLedgerEvent(JSON.parse(line));
						if (
							value.sequence !== index + 1 ||
							value.sessionId !== file.slice(0, -6) ||
							(index === 0) !== (value.data.type === "created")
						)
							throw new Error("Invalid journal sequence or creation boundary");
					} catch (error) {
						throw new Error(`Invalid journal ${file} at sequence ${index + 1}: ${String(error)}`);
					}
					return value;
				});
			if (events.length) {
				const id = file.slice(0, -6);
				this.sessions.set(id, events);
				this.projections.set(id, project(events));
				this.sizes.set(
					id,
					events.map((event) => Buffer.byteLength(JSON.stringify(event))),
				);
				for (const event of events) this.indexEvent(event);
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
		return this.snapshot(id);
	}
	/** Project metadata without cloning historical message/tool bodies excluded by the cursor. */
	snapshot(id: string, after = 0): RelaySession {
		const events = this.sessions.get(id);
		if (!events) throw new Error("Unknown Relay session");
		const session = this.projections.get(id)!;
		return structuredClone({ ...session, events: events.slice(after) });
	}
	/** Byte-bounded page; a single large event uses the transport's chunked transfer. */
	page(
		id: string,
		after = 0,
		byteLimit = 1024 * 1024,
		through?: number,
	): RelaySession & { next?: number; through: number } {
		const events = this.sessions.get(id);
		if (!events) throw new Error("Unknown Relay session");
		const boundary = Math.min(through ?? events.length, events.length);
		const sizes = this.sizes.get(id)!;
		let end = Math.min(after, boundary);
		let bytes = 0;
		while (end < boundary && (end === after || bytes + sizes[end] <= byteLimit)) bytes += sizes[end++];
		return structuredClone({
			...this.projections.get(id)!,
			events: events.slice(after, end),
			through: boundary,
			...(end < boundary ? { next: end } : {}),
		});
	}
	metadata(): Omit<RelaySession, "events">[] {
		return [...this.projections.values()].map(({ events: _events, ...session }) => structuredClone(session));
	}
	private indexEvent(event: LedgerEvent): void {
		const { sessionId, data } = event;
		if (data.type === "created" || data.type === "workspace") {
			for (const ids of this.workspaces.values()) ids.delete(sessionId);
			const ids = this.workspaces.get(data.workspace) ?? new Set<string>();
			ids.add(sessionId);
			this.workspaces.set(data.workspace, ids);
		}
		if (data.type === "manual_edit") {
			const edits = this.edits.get(sessionId) ?? new Map<string, string>();
			edits.set(data.operationId, data.status);
			this.edits.set(sessionId, edits);
		}
	}
	workspaceBlocked(workspace: string): boolean {
		for (const id of this.workspaces.get(workspace) ?? []) {
			if (this.projections.get(id)!.turns.some((turn) => turn.status === "unknown")) return true;
			for (const status of this.edits.get(id)?.values() ?? []) if (status !== "completed") return true;
		}
		return false;
	}
	forgetEphemeral(id: string): Promise<void> {
		const operation = this.pending.then(async () => {
			if (!this.get(id).ephemeral) throw new Error("Only ephemeral sessions may be forgotten");
			await rm(join(this.directory, `${id}.jsonl`));
			await syncDirectory(this.directory);
			this.sessions.delete(id);
			this.projections.delete(id);
			this.sizes.delete(id);
			this.edits.delete(id);
			for (const ids of this.workspaces.values()) ids.delete(id);
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
			events.push(event);
			this.sessions.set(id, events);
			const projection = this.projections.get(id);
			if (projection) applyEvent(projection, event);
			else this.projections.set(id, project(events));
			const sizes = this.sizes.get(id) ?? [];
			sizes.push(Buffer.byteLength(JSON.stringify(event)));
			this.sizes.set(id, sizes);
			this.indexEvent(event);
			return structuredClone(event);
		});
		this.pending = operation.catch(() => {});
		return operation;
	}
}
