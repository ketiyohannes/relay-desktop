import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LedgerEvent, RelaySession } from "../contracts.ts";
import { serviceBuild } from "./build.ts";
import { FrameReader, FrameWriter } from "./frames.ts";
import type { HostedControl } from "./hosted.ts";
import { applicationDirectory, socketPath } from "./paths.ts";
import type { RelayCommand, Request, Response } from "./protocol.ts";
import { within } from "./settlement.ts";

export class RelayDisconnectedError extends Error {}
export class RelayServiceVersionError extends Error {}

export class RelayClient {
	private readonly socket: Socket;
	private readonly token: string;
	private readonly writer = new FrameWriter();
	private readonly listeners = new Set<(event: LedgerEvent) => void>();
	private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
	private readonly disconnects = new Set<() => void>();
	private readonly controls = new Set<(control: HostedControl) => void>();
	constructor(socket: Socket, token: string) {
		this.socket = socket;
		this.token = token;
		socket.setEncoding("utf8");
		const reader = new FrameReader();
		socket.on("data", (chunk: string) => {
			try {
				reader.read(chunk, (value) => {
					const message = value as
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
				});
			} catch (error) {
				socket.destroy(error instanceof Error ? error : new Error(String(error)));
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
		const build = await serviceBuild();
		const open = async () => {
			const token = await readFile(join(directory, "service.token"), "utf8");
			const socket = connect(socketPath(directory));
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			const client = new RelayClient(socket, token);
			try {
				const hello = (await within(client.request({ type: "hello" }), 3000)) as {
					build: string;
					activeSessions: string[];
				};
				if (!hello || typeof hello.build !== "string" || !Array.isArray(hello.activeSessions))
					throw new RelayServiceVersionError(
						"Relay service returned an invalid build handshake. Restart its background service.",
					);
				if (hello.build !== build) {
					if (!autoStart || hello.activeSessions.length)
						throw new RelayServiceVersionError(
							"Finish the active run and reopen Relay to upgrade its background service.",
						);
					try {
						await within(client.request({ type: "upgrade", build: hello.build }), 3000);
					} catch (error) {
						throw new RelayServiceVersionError(error instanceof Error ? error.message : String(error));
					}
					// Wait for the old listener to close before a replacement claims its lock.
					await within(new Promise<void>((resolve) => socket.once("close", resolve)), 10000);
					await within(
						(async () => {
							for (let attempt = 0; attempt < 400; attempt++) {
								try {
									await readFile(join(directory, "service.lock", "owner.json"));
								} catch (error) {
									if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
									throw error;
								}
								await new Promise<void>((resolve) => setTimeout(resolve, 25));
							}
							throw new RelayServiceVersionError("Relay service did not release its upgrade lock.");
						})(),
						10000,
					);
					client.close();
					throw new Error("Relay service upgrade requested");
				}
				return client;
			} catch (error) {
				client.close();
				if (error instanceof Error && error.message === "Unsupported Relay command")
					throw new RelayServiceVersionError(
						"An outdated Relay service is running. Close the old Relay service before launching this build; session history is retained.",
					);
				throw error;
			}
		};
		try {
			return await open();
		} catch (error) {
			if (error instanceof RelayServiceVersionError) throw error;
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
				if (error instanceof RelayServiceVersionError) throw error;
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
	async request(command: RelayCommand): Promise<unknown> {
		const result = await this.requestFrame(command);
		if (command.type !== "get" && command.type !== "create") return result;
		const session = result as RelaySession & { next?: number; through?: number };
		let next = session.next;
		while (next !== undefined) {
			const page = (await this.requestFrame({
				type: "get",
				sessionId: session.id,
				after: next,
				through: session.through,
			})) as RelaySession & {
				next?: number;
			};
			if (page.next !== undefined && page.next <= next) throw new Error("Journal page cursor did not advance");
			session.events.push(...page.events);
			next = page.next;
		}
		delete session.next;
		delete session.through;
		return session;
	}
	private requestFrame(command: RelayCommand): Promise<unknown> {
		const id = randomUUID();
		const request: Request = { version: 1, id, token: this.token, command };
		return new Promise((resolve, reject) => {
			if (this.socket.destroyed) {
				reject(new RelayDisconnectedError("Relay client disconnected"));
				return;
			}
			this.pending.set(id, { resolve, reject });
			this.writer.send(this.socket, request);
		});
	}
	close(): void {
		this.socket.destroy();
	}
}
