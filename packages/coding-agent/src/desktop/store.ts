import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
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
			await writeFile(temporary, data, { mode: 0o600 });
			await rename(temporary, join(this.directory, "state.json"));
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

	/** SDK-native transcripts remain opaque and are shared across account config directories. */
	claudeTranscripts(): SessionStore {
		let pending = Promise.resolve();
		const file = (key: SessionKey) =>
			join(this.directory, `claude-${createHash("sha256").update(JSON.stringify(key)).digest("hex")}.json`);
		const load = async (key: SessionKey): Promise<SessionStoreEntry[] | null> => {
			try {
				return JSON.parse(await readFile(file(key), "utf8")) as SessionStoreEntry[];
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
		};
		return {
			load,
			append: (key, entries) => {
				const operation = pending.then(async () => {
					const existing = (await load(key)) ?? [];
					const uuids = new Set(existing.map((entry) => entry.uuid).filter(Boolean));
					for (const entry of entries) {
						if (entry.uuid && uuids.has(entry.uuid)) continue;
						existing.push(entry);
						if (entry.uuid) uuids.add(entry.uuid);
					}
					await writeFile(`${file(key)}.tmp`, JSON.stringify(existing), { mode: 0o600 });
					await rename(`${file(key)}.tmp`, file(key));
				});
				pending = operation.catch(() => {});
				return operation;
			},
		};
	}
}
