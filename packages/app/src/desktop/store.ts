import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory, writePrivateFile } from "../storage/durable.ts";
import type { DesktopAction, DesktopSession, DesktopState } from "./types.ts";

export class DesktopStore {
	readonly directory: string;
	state: DesktopState = { projects: [], sessions: [], accounts: [] };
	private pending: Promise<void> = Promise.resolve();
	constructor(directory: string) {
		this.directory = directory;
	}
	async load(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		try {
			this.state = JSON.parse(await readFile(join(this.directory, "state.json"), "utf8")) as DesktopState;
			delete this.state.busySession;
			for (const session of this.state.sessions) {
				for (const action of session.actions) {
					if (action.status === "running") {
						action.status = "error";
						action.text += " (interrupted; verify working files before continuing)";
					}
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	save(): Promise<void> {
		const data = JSON.stringify(this.state);
		const operation = this.pending.then(async () => {
			const temporary = join(this.directory, "state.json.tmp");
			await writePrivateFile(temporary, data);
			await rename(temporary, join(this.directory, "state.json"));
			await syncDirectory(this.directory);
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
