import type { RuntimeEvent } from "../runtimes/types.ts";

import { within } from "../service/settlement.ts";

import type { Execution } from "../sessions/execution.ts";
import type { SessionLedger } from "../sessions/ledger.ts";

import type { LedgerData, LedgerEvent } from "../sessions/types.ts";

import type { Approval } from "./types.ts";

interface ApprovalHost {
	ledger: SessionLedger;
	settlementMs: number;
	append(sessionId: string, data: LedgerData): Promise<LedgerEvent>;
	findExecution(id: string, recordId: string): Execution | undefined;
}

export class ApprovalManager {
	private readonly host: ApprovalHost;
	private readonly approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly approvalResponses = new Map<string, Promise<void>>();
	constructor(host: ApprovalHost) {
		this.host = host;
	}
	async approval(
		execution: Execution,
		event: Extract<RuntimeEvent, { type: "approval" }>,
		taskId?: string,
	): Promise<void> {
		const approval: Approval = {
			id: event.id,
			nativeRecordId: execution.record.id,
			turnId: execution.turnId,
			taskId,
			tool: event.tool,
			input: event.input,
			expiresAt: Date.now() + 120000,
			status: "pending",
		};
		const timer = setTimeout(() => {
			void this.respond(execution.sessionId, event.id, false, "expired").catch(() => {});
		}, 120000);
		timer.unref();
		this.approvalTimers.set(event.id, timer);
		try {
			if (taskId) {
				const task = this.host.ledger.get(execution.sessionId).tasks.find((task) => task.id === taskId);
				if (task) await this.host.append(execution.sessionId, { type: "task", task: { ...task, status: "blocked" } });
			}
			await this.host.append(execution.sessionId, { type: "approval", approval });
			if (execution.cancelled) await this.respond(execution.sessionId, event.id, false, "interrupted");
		} catch (error) {
			clearTimeout(timer);
			this.approvalTimers.delete(event.id);
			throw error;
		}
	}
	async respond(id: string, approvalId: string, allowed: boolean, status?: Approval["status"]): Promise<void> {
		const key = `${id}:${approvalId}`;
		if (this.approvalResponses.has(key)) throw new Error("Approval response already in progress");
		const approval = this.host.ledger.get(id).approvals.find((entry) => entry.id === approvalId);
		if (!approval || approval.status !== "pending") throw new Error("Approval no longer pending");
		const execution = this.host.findExecution(id, approval.nativeRecordId);
		if (!execution?.connection) throw new Error("Approval runtime disconnected");
		if (allowed && (approval.expiresAt <= Date.now() || execution.cancelled)) {
			allowed = false;
			status = execution.cancelled ? "interrupted" : "expired";
		}
		const operation = (async () => {
			const response = await within(execution.connection!.respond(approvalId, allowed), this.host.settlementMs);
			if (response !== "sent") throw new Error(`Approval response ${response}`);
			const timer = this.approvalTimers.get(approvalId);
			if (timer) clearTimeout(timer);
			this.approvalTimers.delete(approvalId);
			if (this.host.ledger.get(id).approvals.find((entry) => entry.id === approvalId)?.status !== "pending") return;
			await this.host.append(id, {
				type: "approval",
				approval: {
					...approval,
					status: execution.cancelled ? "interrupted" : (status ?? (allowed ? "allowed" : "denied")),
				},
			});
			if (approval.taskId && execution.status === "running" && !execution.cancelled) {
				const task = this.host.ledger.get(id).tasks.find((task) => task.id === approval.taskId);
				if (task?.status === "blocked" && !task.result)
					await this.host.append(id, { type: "task", task: { ...task, status: "running" } });
			}
		})();
		this.approvalResponses.set(key, operation);
		try {
			await operation;
		} finally {
			this.approvalResponses.delete(key);
		}
	}
	async closeApprovals(execution: Execution): Promise<void> {
		for (const approval of this.host.ledger
			.get(execution.sessionId)
			.approvals.filter(
				(approval) => approval.nativeRecordId === execution.record.id && approval.status === "pending",
			)) {
			const timer = this.approvalTimers.get(approval.id);
			if (timer) clearTimeout(timer);
			this.approvalTimers.delete(approval.id);
			const response = this.approvalResponses.get(`${execution.sessionId}:${approval.id}`);
			if (response)
				await within(response, this.host.settlementMs).catch(() => {
					execution.quarantined = true;
				});
			else if (execution.connection)
				await this.respond(execution.sessionId, approval.id, false, "interrupted").catch(() => {
					execution.quarantined = true;
				});
			if (
				this.host.ledger.get(execution.sessionId).approvals.find((entry) => entry.id === approval.id)?.status ===
				"pending"
			)
				await this.host.append(execution.sessionId, {
					type: "approval",
					approval: { ...approval, status: "interrupted" },
				});
		}
	}
}
