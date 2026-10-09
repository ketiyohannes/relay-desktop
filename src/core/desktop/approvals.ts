import type { Approval } from "../contracts.ts";

/** Present each live approval once, independently of the conversation projection cursor. */
export class ApprovalPresenter {
	private readonly pending = new Map<string, AbortController>();
	private readonly present: (approval: Approval, sessionId: string, signal: AbortSignal) => Promise<boolean>;
	private readonly respond: (sessionId: string, approvalId: string, allowed: boolean) => Promise<void>;
	constructor(
		present: (approval: Approval, sessionId: string, signal: AbortSignal) => Promise<boolean>,
		respond: (sessionId: string, approvalId: string, allowed: boolean) => Promise<void>,
	) {
		this.present = present;
		this.respond = respond;
	}
	update(sessionId: string, approval: Approval): void {
		const key = `${sessionId}:${approval.id}`;
		if (approval.status !== "pending" || approval.expiresAt <= Date.now()) {
			this.pending.get(key)?.abort();
			this.pending.delete(key);
			return;
		}
		if (this.pending.has(key)) return;
		const controller = new AbortController();
		this.pending.set(key, controller);
		void this.present(approval, sessionId, controller.signal)
			.then(async (allowed) => {
				if (!controller.signal.aborted) await this.respond(sessionId, approval.id, allowed);
			})
			.catch(() => {})
			.finally(() => {
				// Retain the entry until the service confirms settlement; snapshots cannot open it twice.
				controller.abort();
			});
	}
	close(): void {
		for (const controller of this.pending.values()) controller.abort();
		this.pending.clear();
	}
}
