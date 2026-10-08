import type { ExecutionStatus, RuntimeConnection, RuntimeEvent, TurnInput } from "../contracts.ts";

export type HostedControl =
	| { turnId: string; type: "cancel" }
	| { turnId: string; type: "approval"; approvalId: string; allowed: boolean };

/** A published pi runtime hosted by the terminal; Relay still owns the execution lease. */
export class HostedConnection implements RuntimeConnection {
	readonly nativeId: string;
	readonly ready: Promise<TurnInput>;
	private accept!: (input: TurnInput) => void;
	private rejectReady!: (error: Error) => void;
	private readonly control: (control: HostedControl) => boolean;
	private readonly turnId: string;
	private emit?: (event: RuntimeEvent) => Promise<void>;
	private finish?: () => void;
	private failure?: (error: Error) => void;
	private settled = false;
	private disconnected = false;
	private queue: Promise<void> = Promise.resolve();
	constructor(nativeId: string, turnId: string, control: (control: HostedControl) => boolean) {
		this.nativeId = nativeId;
		this.turnId = turnId;
		this.control = control;
		this.ready = new Promise((resolve, reject) => {
			this.accept = resolve;
			this.rejectReady = reject;
		});
		void this.ready.catch(() => {});
	}
	async submit(input: TurnInput, emit: (event: RuntimeEvent) => Promise<void>): Promise<void> {
		if (this.disconnected) throw new Error("Hosted runtime disconnected before submission");
		this.emit = emit;
		const done = new Promise<void>((resolve, reject) => {
			this.finish = resolve;
			this.failure = reject;
		});
		this.accept(input);
		await done;
	}
	event(event: RuntimeEvent): Promise<void> {
		const operation = this.queue.then(async () => {
			if (!this.emit || this.disconnected || this.settled) throw new Error("Hosted execution inactive");
			await this.emit(event);
		});
		this.queue = operation.catch(() => {});
		return operation;
	}
	async complete(status: Exclude<ExecutionStatus, "running">): Promise<void> {
		await this.event({ type: "done", status });
		this.settled = status !== "unknown";
		this.finish?.();
	}
	disconnect(): void {
		this.disconnected = true;
		const error = new Error("Hosted runtime disconnected; no execution replay");
		this.rejectReady(error);
		this.failure?.(error);
	}
	failed(error: unknown): void {
		this.rejectReady(error instanceof Error ? error : new Error(String(error)));
	}
	async respond(approvalId: string, allowed: boolean): Promise<"sent" | "expired"> {
		return !this.disconnected && this.control({ type: "approval", turnId: this.turnId, approvalId, allowed })
			? "sent"
			: "expired";
	}
	async cancel(): Promise<"requested" | "unknown"> {
		return !this.disconnected && this.control({ type: "cancel", turnId: this.turnId }) ? "requested" : "unknown";
	}
	async release(): Promise<"settled" | "unknown"> {
		return this.settled && !this.disconnected ? "settled" : "unknown";
	}
}
