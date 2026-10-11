import { randomUUID } from "node:crypto";
import type { DesktopCommand } from "./types.ts";

const queries = new Set<DesktopCommand["type"]>([
	"state",
	"recovery",
	"browse",
	"workspace",
	"history",
	"snapshot",
	"search_code",
	"editor_read",
	"external_preview",
	"external_sessions",
	"account_usage",
	"timeline_status",
]);

/** A deadline cannot settle a mutation. Keep its promise and identity until the worker responds. */
export class DesktopRequests {
	private readonly pending = new Map<
		string,
		{
			resolve(value: unknown): void;
			reject(error: Error): void;
			mutating: boolean;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	request(
		command: DesktopCommand,
		send: (id: string, command: DesktopCommand) => void,
		slow: (message: string) => void,
		deadlineMs = 30000,
	): Promise<unknown> {
		const id = randomUUID();
		const mutating = !queries.has(command.type);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (mutating) slow(`Command ${id} (${command.type}) is still pending. Wait for completion before retrying.`);
				else {
					this.pending.delete(id);
					reject(new Error(`Query ${id} timed out`));
				}
			}, deadlineMs);
			this.pending.set(id, { resolve, reject, mutating, timer });
			try {
				send(id, command);
			} catch (error) {
				this.complete(id, undefined, String(error));
			}
		});
	}
	complete(id: string, value?: unknown, error?: string): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(id);
		if (error) pending.reject(new Error(error));
		else pending.resolve(value);
	}
	disconnected(): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(
				new Error(
					pending.mutating
						? `Command ${id} completion is unknown after worker disconnect. Inspect state and effects before retrying.`
						: "Agent worker unavailable",
				),
			);
		}
		this.pending.clear();
	}
}
