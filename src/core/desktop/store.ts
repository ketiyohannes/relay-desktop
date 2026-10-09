import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory, writePrivateFile } from "../storage/durable.ts";
import type { DesktopAction, DesktopSession, DesktopState } from "./types.ts";

export class DesktopStore {
	readonly directory: string;
	state: DesktopState = { projects: [], sessions: [], accounts: [] };
	private pending: Promise<void> = Promise.resolve();
	private readonly saved = new Map<string, string>();
	private index = "";
	private historyPath(id: string): string {
		return join(this.directory, "conversations", `${createHash("sha256").update(id).digest("hex")}.json`);
	}
	constructor(directory: string) {
		this.directory = directory;
	}
	async load(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		let found = false;
		try {
			const raw = await readFile(join(this.directory, "state.json"), "utf8");
			found = true;
			const stored = JSON.parse(raw) as DesktopState & { storageVersion?: number };
			this.state = stored;
			if (stored.storageVersion === 1) {
				for (const session of this.state.sessions) {
					const data = await readFile(this.historyPath(session.id), "utf8");
					const history = JSON.parse(data) as { actions: DesktopAction[]; relayLedgerSequence?: number };
					session.actions = history.actions;
					// The history and its replay cursor commit together, even if index replacement fails.
					session.relayLedgerSequence = history.relayLedgerSequence;
					this.saved.set(session.id, data);
				}
			} else {
				if (stored.storageVersion !== undefined) throw new Error("Unsupported desktop storage version");
				// Preserve the original until every conversation and the new index are durable.
				await writePrivateFile(join(this.directory, "state.legacy.json"), raw);
			}
			delete stored.storageVersion;
			delete this.state.busySession;
			for (const session of this.state.sessions) {
				if (
					!session.permissionMode ||
					!["ask", "auto-approve", "full-access", "read-only"].includes(session.permissionMode)
				)
					session.permissionMode = "ask";
				session.timelineEnabled ??= this.state.timelineProjects?.includes(session.project) ?? false;
				for (const action of session.actions) {
					if (action.status === "running") {
						action.status = "error";
						action.text += " (interrupted; verify working files before continuing)";
					}
				}
			}
			delete this.state.timelineProjects;
		} catch (error) {
			if (found || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	save(sessionIds?: readonly string[]): Promise<void> {
		const histories = this.state.sessions
			.filter((session) => !sessionIds || sessionIds.includes(session.id) || !this.saved.has(session.id))
			.map((session) => ({
				id: session.id,
				data: JSON.stringify({ actions: session.actions, relayLedgerSequence: session.relayLedgerSequence }),
			}));
		const data = JSON.stringify({
			...this.state,
			storageVersion: 1,
			sessions: this.state.sessions.map((session) => ({ ...session, actions: [] })),
		});
		const operation = this.pending.then(async () => {
			await mkdir(join(this.directory, "conversations"), { recursive: true, mode: 0o700 });
			for (const history of histories) {
				if (this.saved.get(history.id) === history.data) continue;
				const path = this.historyPath(history.id);
				await writePrivateFile(`${path}.tmp`, history.data);
				await rename(`${path}.tmp`, path);
				await syncDirectory(join(this.directory, "conversations"));
				this.saved.set(history.id, history.data);
			}
			if (this.index === data) return;
			const temporary = join(this.directory, "state.json.tmp");
			await writePrivateFile(temporary, data);
			await rename(temporary, join(this.directory, "state.json"));
			await syncDirectory(this.directory);
			this.index = data;
		});
		this.pending = operation.catch(() => {});
		return operation;
	}
	session(id: string): DesktopSession {
		const session = this.state.sessions.find((s) => s.id === id);
		if (!session) throw new Error("Unknown session");
		return session;
	}
	append(session: DesktopSession, action: Omit<DesktopAction, "id" | "time">): DesktopAction {
		const entry = { ...action, id: randomUUID(), time: Date.now() };
		session.actions.push(entry);
		session.updated = entry.time;
		return entry;
	}
}
