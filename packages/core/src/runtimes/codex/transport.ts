import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stopProcessGroup } from "../process-group.ts";

export function codexExecutable(): string {
	const standalone = join(homedir(), ".local", "bin", "codex");
	return process.env.RELAY_CODEX_PATH || (existsSync(standalone) ? standalone : "codex");
}

export interface RpcMessage {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}
export interface CodexTransport {
	request(method: string, params: unknown): Promise<unknown>;
	notify(method: string, params?: unknown): void;
	respond(id: number | string, result: unknown): void;
	reject(id: number | string, message: string): void;
	onMessage(handler: (message: RpcMessage) => void): () => void;
	onDisconnect(handler: (error: Error) => void): () => void;
	close(): Promise<"settled" | "unknown">;
}

export class StdioCodexTransport implements CodexTransport {
	private readonly child: ChildProcessWithoutNullStreams;
	private nextId = 0;
	private readonly pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
	>();
	private readonly listeners = new Set<(message: RpcMessage) => void>();
	private readonly disconnects = new Set<(error: Error) => void>();
	private closed = false;
	private stopping?: Promise<"settled" | "unknown">;
	private readonly exited: Promise<void>;
	constructor(profile: string, executable = codexExecutable()) {
		this.child = spawn(executable, ["app-server", "--listen", "stdio://"], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			env: { ...process.env, ...(profile ? { CODEX_HOME: profile } : {}) },
		});
		this.exited = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
		this.child.stderr.on("data", () => {
			/* Native diagnostics may contain sensitive paths; keep them out of history. */
		});
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			try {
				const message = JSON.parse(line) as RpcMessage;
				if (message.id !== undefined && !message.method && typeof message.id === "number") {
					const pending = this.pending.get(message.id);
					if (pending) {
						clearTimeout(pending.timer);
						this.pending.delete(message.id);
						if (message.error) pending.reject(new Error(message.error.message));
						else pending.resolve(message.result);
					}
				} else for (const listener of this.listeners) listener(message);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
		this.child.on("error", (error) => this.fail(error));
		this.child.on("exit", () => this.fail(new Error("Codex App Server disconnected")));
	}
	private fail(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const handler of this.disconnects) handler(error);
	}
	private send(message: RpcMessage): void {
		if (this.closed || !this.child.stdin.writable) throw new Error("Codex transport closed");
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}
	request(method: string, params: unknown): Promise<unknown> {
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Codex ${method} response timed out; acceptance may be unknown`));
			}, 30000);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.send({ id, method, params });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			}
		});
	}
	notify(method: string, params?: unknown): void {
		this.send({ method, params });
	}
	respond(id: number | string, result: unknown): void {
		this.send({ id, result });
	}
	reject(id: number | string, message: string): void {
		this.send({ id, error: { code: -32601, message } });
	}
	onMessage(handler: (message: RpcMessage) => void): () => void {
		this.listeners.add(handler);
		return () => this.listeners.delete(handler);
	}
	onDisconnect(handler: (error: Error) => void): () => void {
		this.disconnects.add(handler);
		return () => this.disconnects.delete(handler);
	}
	async close(): Promise<"settled" | "unknown"> {
		if (this.stopping) return this.stopping;
		this.closed = true;
		this.child.stdin.end();
		this.stopping = stopProcessGroup(this.child, this.exited);
		return this.stopping;
	}
}
