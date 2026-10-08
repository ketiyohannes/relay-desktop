import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { LedgerEvent } from "../contracts.ts";
import { syncDirectory, writePrivateFile } from "../storage/durable.ts";
import type { RelayApplication } from "./application.ts";
import { HostedConnection, type HostedControl } from "./hosted.ts";
import { socketPath } from "./paths.ts";
import type { RelayCommand, Request, Response } from "./protocol.ts";
import { validateHostedEvent, validateSelection } from "./protocol.ts";

const maxFrame = 16 * 1024 * 1024;

export class RelayServer {
	private readonly application: RelayApplication;
	private readonly directory: string;
	private readonly sockets = new Set<Socket>();
	private readonly hosts = new Map<
		string,
		{ socket: Socket; sessionId: string; connection: HostedConnection; execution: Promise<unknown> }
	>();
	private server?: Server;
	private token = "";
	private unsubscribe?: () => void;
	private owned = false;
	constructor(application: RelayApplication, directory: string) {
		this.application = application;
		this.directory = directory;
	}
	async start(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const lock = join(this.directory, "service.lock");
		try {
			await mkdir(lock, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const recovery = join(this.directory, "service-recovery.lock");
			await mkdir(recovery, { mode: 0o700 });
			try {
				const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as { pid: number };
				if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
					throw new Error("Invalid service lock owner; inspect before recovery");
				try {
					process.kill(owner.pid, 0);
					throw new Error("Relay service already running");
				} catch (failure) {
					if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure;
				}
				const obsolete = `${lock}.dead-${randomUUID()}`;
				await rename(lock, obsolete);
				await mkdir(lock, { mode: 0o700 });
				await rm(obsolete, { recursive: true });
			} finally {
				await rm(recovery, { recursive: true });
			}
		}
		this.owned = true;
		try {
			await writePrivateFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
			await syncDirectory(lock);
			this.token = randomUUID();
			await writePrivateFile(join(this.directory, "service.token"), this.token);
			await syncDirectory(this.directory);
			await this.application.initialize();
			if (process.platform !== "win32") await rm(socketPath(this.directory), { force: true });
			this.server = createServer((socket) => this.accept(socket));
			await new Promise<void>((resolve, reject) => {
				this.server!.once("error", reject);
				this.server!.listen(socketPath(this.directory), resolve);
			});
			if (process.platform !== "win32") await chmod(socketPath(this.directory), 0o600);
			this.unsubscribe = this.application.subscribe((event) => this.broadcast(event));
		} catch (error) {
			await this.close();
			throw error;
		}
	}
	private accept(socket: Socket): void {
		let buffer = "";
		let authenticated = false;
		const submissions = new Map<string, { sessionId: string; turnId: string }>();
		this.sockets.add(socket);
		socket.setEncoding("utf8");
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			this.sockets.delete(socket);
			for (const [turnId, host] of this.hosts)
				if (host.socket === socket) {
					host.connection.disconnect();
					void this.application.cancel(host.sessionId, turnId).catch(() => {});
					void host.execution.finally(() => this.hosts.delete(turnId)).catch(() => {});
				}
			for (const { turnId, sessionId } of submissions.values())
				void this.application.cancel(sessionId, turnId).catch(() => {});
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > maxFrame) {
				socket.destroy();
				return;
			}
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const frame = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				let request: Request;
				try {
					request = JSON.parse(frame) as Request;
					const received = Buffer.from(request.token || "");
					const expected = Buffer.from(this.token);
					if (
						request.version !== 1 ||
						typeof request.id !== "string" ||
						received.length !== expected.length ||
						!timingSafeEqual(received, expected)
					) {
						socket.destroy();
						return;
					}
					authenticated = true;
				} catch {
					socket.destroy();
					return;
				}
				const sessionId = request.command?.type === "submit" ? request.command.sessionId : undefined;
				const turnId = request.command?.type === "submit" ? request.command.turnId : undefined;
				const operation = this.socketCommand(socket, request.command, () => {
					if (!sessionId || !turnId) return;
					submissions.set(request.id, { sessionId, turnId });
					if (socket.destroyed) void this.application.cancel(sessionId, turnId).catch(() => {});
				});
				void operation
					.then(
						(result) => this.send(socket, { version: 1, id: request.id, result }),
						(error: unknown) =>
							this.send(socket, {
								version: 1,
								id: request.id,
								error: error instanceof Error ? error.message : String(error),
							}),
					)
					.finally(() => {
						submissions.delete(request.id);
					});
			}
		});
		// Broadcasts must only reach authenticated clients.
		Object.defineProperty(socket, "relayAuthenticated", { get: () => authenticated });
	}
	private send(
		socket: Socket,
		response: Response | { version: 1; event: LedgerEvent } | { version: 1; control: HostedControl },
	): void {
		if (socket.destroyed) return;
		const frame = `${JSON.stringify(response)}\n`;
		if (Buffer.byteLength(frame) > maxFrame) {
			if ("id" in response)
				socket.write(
					`${JSON.stringify({ version: 1, id: response.id, error: "Response too large; export the session journal from the application directory" })}\n`,
				);
			return;
		}
		if (socket.writableLength > maxFrame) {
			socket.destroy();
			return;
		}
		socket.write(frame);
	}
	private broadcast(event: LedgerEvent): void {
		for (const socket of this.sockets)
			if (Reflect.get(socket, "relayAuthenticated")) this.send(socket, { version: 1, event });
	}
	private async socketCommand(socket: Socket, command: RelayCommand, reserved?: () => void): Promise<unknown> {
		if (command?.type === "host_start") {
			if (
				validateSelection(command.selection).backend !== "pi" ||
				!["ask", "auto-edit", "read-only"].includes(command.permissionMode) ||
				typeof command.nativeId !== "string" ||
				typeof command.text !== "string" ||
				typeof command.turnId !== "string"
			)
				throw new Error("Invalid hosted pi turn");
			if (this.hosts.has(command.turnId))
				throw new Error("Hosted turn already registered; inspect without resubmitting");
			if (this.application.ledger.get(command.sessionId).turns.some((turn) => turn.id === command.turnId))
				throw new Error("Hosted turn already recorded; inspect without resubmitting");
			await this.application.select(command.sessionId, command.selection);
			const connection = new HostedConnection(command.nativeId, command.turnId, (control) => {
				if (socket.destroyed) return false;
				this.send(socket, { version: 1, control });
				return !socket.destroyed;
			});
			const execution = this.application.submit(
				command.sessionId,
				command.text,
				command.permissionMode,
				command.turnId,
				{ connection, nativeFile: command.nativeFile },
				undefined,
				command.attachmentIds,
			);
			void execution.catch((error: unknown) => connection.failed(error));
			this.hosts.set(command.turnId, { socket, sessionId: command.sessionId, connection, execution });
			if (socket.destroyed) connection.disconnect();
			try {
				return await connection.ready;
			} catch (error) {
				this.hosts.delete(command.turnId);
				throw error;
			}
		}
		if (command?.type === "host_event" || command?.type === "host_finish" || command?.type === "host_delegate") {
			const host = this.hosts.get(command.turnId);
			if (!host || host.socket !== socket)
				throw new Error("Hosted turn belongs to another connection or is inactive");
			if (command.type === "host_delegate")
				return this.application.delegateHosted(host.sessionId, command.turnId, command.request);
			if (command.type === "host_event") {
				return host.connection.event(validateHostedEvent(command.event));
			}
			if (!["completed", "failed", "cancelled", "unknown"].includes(command.status))
				throw new Error("Invalid hosted completion");
			await host.connection.complete(command.status);
			try {
				return await host.execution;
			} finally {
				this.hosts.delete(command.turnId);
			}
		}
		return this.command(command, reserved);
	}
	async command(command: RelayCommand, reserved?: () => void): Promise<unknown> {
		if (!command || typeof command.type !== "string") throw new Error("Invalid Relay command");
		switch (command.type) {
			case "list":
				return this.application.ledger.list().map(({ events: _events, ...session }) => session);
			case "get":
				return this.application.ledger.get(command.sessionId);
			case "attach":
				return this.application.attach(command.sessionId, command.mediaType, command.data, command.description);
			case "copy_attachment":
				return this.application.copyAttachment(command.sessionId, command.sourceSessionId, command.attachmentId);
			case "create": {
				if (this.application.ledger.has(command.sessionId)) return this.application.ledger.get(command.sessionId);
				return this.application.create(
					command.workspace,
					validateSelection(command.selection),
					command.name,
					command.sessionId,
					command.parentSessionId,
					command.ephemeral === true,
					command.purpose,
				);
			}
			case "select":
				return this.application.select(command.sessionId, validateSelection(command.selection));
			case "forget_ephemeral":
				return this.application.forgetEphemeral(command.sessionId);
			case "note":
				return this.application.recordNote(command.sessionId, command.note);
			case "workspace":
				return this.application.changeWorkspace(command.sessionId, command.workspace);
			case "capabilities":
				return this.application.capabilities(validateSelection(command.selection));
			case "submit": {
				if (
					!["ask", "auto-edit", "read-only"].includes(command.permissionMode) ||
					typeof command.text !== "string" ||
					typeof command.turnId !== "string"
				)
					throw new Error("Invalid turn");
				return this.application.submit(
					command.sessionId,
					command.text,
					command.permissionMode,
					command.turnId,
					undefined,
					reserved,
					command.attachmentIds,
				);
			}
			case "approval":
				return this.application.respond(command.sessionId, command.approvalId, command.allowed === true);
			case "cancel":
				return this.application.cancel(command.sessionId);
			case "wait":
				return this.application.wait(command.sessionId);
			case "reconcile":
				return this.application.reconcile(command.sessionId, command.turnId, command.description);
			case "reset":
				return this.application.resetNative(command.sessionId, command.description);
			case "edit":
				return this.application.edit(
					command.sessionId,
					command.operationId,
					command.path,
					command.expected,
					command.content,
				);
			case "import":
				return this.application.importHistory(command.sessionId, command.data);
			default:
				throw new Error("Unsupported Relay command");
		}
	}
	async close(): Promise<void> {
		this.unsubscribe?.();
		for (const host of this.hosts.values()) host.connection.disconnect();
		await this.application.shutdown();
		for (const socket of this.sockets) socket.destroy();
		if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
		if (this.owned) {
			await rm(join(this.directory, "service.lock"), { recursive: true, force: true });
			this.owned = false;
		}
	}
}
