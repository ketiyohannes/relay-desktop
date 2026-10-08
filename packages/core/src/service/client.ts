import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LedgerEvent } from "../contracts.ts";
import type { HostedControl } from "./hosted.ts";
import { applicationDirectory, socketPath } from "./paths.ts";
import type { RelayCommand, Request, Response } from "./protocol.ts";

export class RelayDisconnectedError extends Error {}

export class RelayClient {
	private readonly socket: Socket;
	private readonly token: string;
	private buffer = "";
	private readonly listeners = new Set<(event: LedgerEvent) => void>();
	private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
	private readonly disconnects = new Set<() => void>();
	private readonly controls = new Set<(control: HostedControl) => void>();
	constructor(socket: Socket, token: string) {
		this.socket = socket;
		this.token = token;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			this.buffer += chunk;
			if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) {
				socket.destroy(new Error("Relay response exceeded frame limit"));
				return;
			}
			let newline = this.buffer.indexOf("\n");
			while (newline >= 0) {
				const frame = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				newline = this.buffer.indexOf("\n");
				try {
					const message = JSON.parse(frame) as
						| Response
						| { version: 1; event: LedgerEvent }
						| { version: 1; control: HostedControl };
					if ("control" in message) {
						for (const listener of this.controls) listener(message.control);
					} else if ("event" in message) {
						for (const listener of this.listeners) listener(message.event);
					} else {
						const pending = this.pending.get(message.id);
						this.pending.delete(message.id);
						if (message.error) pending?.reject(new Error(message.error));
						else pending?.resolve(message.result);
					}
				} catch (error) {
					socket.destroy(error instanceof Error ? error : new Error(String(error)));
				}
			}
		});
		const fail = () => {
			for (const pending of this.pending.values())
				pending.reject(
					new RelayDisconnectedError(
						"Relay disconnected; execution acceptance may be unknown. Reconnect and inspect, do not resubmit automatically.",
					),
				);
			this.pending.clear();
			for (const listener of this.disconnects) listener();
		};
		socket.on("error", fail);
		socket.on("close", fail);
	}
	static async connect(directory = applicationDirectory(), autoStart = true): Promise<RelayClient> {
		const open = async () => {
			const token = await readFile(join(directory, "service.token"), "utf8");
			const socket = connect(socketPath(directory));
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			return new RelayClient(socket, token);
		};
		try {
			return await open();
		} catch (error) {
			if (!autoStart) throw error;
		}
		const child = spawn(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
			detached: true,
			stdio: "ignore",
			env: { ...process.env, RELAY_APP_DIR: directory },
		});
		child.unref();
		child.on("error", () => {});
		let failure: unknown;
		for (let attempt = 0; attempt < 100; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
			try {
				return await open();
			} catch (error) {
				failure = error;
			}
		}
		throw new Error(
			`Relay service failed to start: ${String(failure)}. Start npm run relay:service to inspect startup errors.`,
		);
	}
	subscribe(listener: (event: LedgerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	onDisconnect(listener: () => void): () => void {
		this.disconnects.add(listener);
		return () => this.disconnects.delete(listener);
	}
	onControl(listener: (control: HostedControl) => void): () => void {
		this.controls.add(listener);
		return () => this.controls.delete(listener);
	}
	request(command: RelayCommand): Promise<unknown> {
		const id = randomUUID();
		const request: Request = { version: 1, id, token: this.token, command };
		return new Promise((resolve, reject) => {
			if (this.socket.destroyed) {
				reject(new RelayDisconnectedError("Relay client disconnected"));
				return;
			}
			this.pending.set(id, { resolve, reject });
			this.socket.write(`${JSON.stringify(request)}\n`);
		});
	}
	close(): void {
		this.socket.destroy();
	}
}
