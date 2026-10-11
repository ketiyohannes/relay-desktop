import { randomUUID } from "node:crypto";

import type { ResourceLeases } from "../resources/leases.ts";

import type { Execution } from "./execution.ts";
import type { SessionLedger } from "./ledger.ts";

import type { LedgerData, LedgerEvent, RecoveryEntry, RelaySession } from "./types.ts";

export interface RecoveryHost {
	ledger: SessionLedger;
	resources: ResourceLeases;
	active: ReadonlyMap<string, Execution>;
	append(sessionId: string, data: LedgerData): Promise<LedgerEvent>;
	forgetEphemeral(id: string): Promise<void>;
}

export async function recoverRestart(host: RecoveryHost): Promise<void> {
	for (const session of host.ledger.list()) {
		const edits = new Map(
			session.events.flatMap((event) =>
				event.data.type === "manual_edit" ? [[event.data.operationId, event.data] as const] : [],
			),
		);
		for (const edit of edits.values())
			if (edit.status === "prepared") await host.append(session.id, { ...edit, status: "unknown" });
		for (const turn of session.turns.filter((turn) => turn.status === "running")) {
			const record = session.natives.find((record) => record.id === turn.nativeRecordId);
			if (record) await host.append(session.id, { type: "native", record: { ...record, status: "unknown" } });
			await host.append(session.id, {
				type: "turn",
				turnId: turn.id,
				nativeRecordId: turn.nativeRecordId,
				taskId: turn.taskId,
				status: "unknown",
			});
			await host.append(session.id, {
				type: "recovery",
				description: `Turn ${turn.id} interrupted by application restart. Native tools may still be acting; verify their state and effects. No automatic replay.`,
			});
		}
		for (const approval of session.approvals.filter((approval) => approval.status === "pending"))
			await host.append(session.id, { type: "approval", approval: { ...approval, status: "interrupted" } });
		for (const task of session.tasks.filter(
			(task) => task.status === "running" || (task.status === "blocked" && !task.result),
		))
			await host.append(session.id, { type: "task", task: { ...task, status: "unknown" } });
		// A crash between durable completion and lease removal still requires recovery.
		for (const workspace of new Set([session.workspace, ...session.natives.map((native) => native.workspace)])) {
			const resource = `workspace:${workspace}`;
			const lease = await host.resources.owner(resource);
			if (!lease?.owner.startsWith(`${session.id}:`)) continue;
			const operationId = lease.owner.slice(session.id.length + 1);
			if (operationId.startsWith("edit:")) {
				const edit = edits.get(operationId.slice(5));
				if (edit) await host.append(session.id, { ...edit, status: "unknown" });
				else await host.resources.release(lease); // No prepared boundary: editor could not execute.
			} else {
				const turn = host.ledger.get(session.id).turns.find((turn) => turn.id === operationId);
				if (turn)
					await host.append(session.id, {
						type: "turn",
						turnId: turn.id,
						nativeRecordId: turn.nativeRecordId,
						taskId: turn.taskId,
						status: "unknown",
					});
				else await host.resources.release(lease); // No turn boundary: runtime could not open.
			}
		}
		for (const task of session.tasks) {
			if (!task.resource) continue;
			const lease = await host.resources.owner(task.resource);
			if (lease?.owner !== task.id) continue;
			const turn = host.ledger.get(session.id).turns.find((turn) => turn.taskId === task.id);
			if (turn) {
				await host.append(session.id, {
					type: "turn",
					turnId: turn.id,
					nativeRecordId: turn.nativeRecordId,
					taskId: task.id,
					status: "unknown",
				});
				await host.append(session.id, { type: "task", task: { ...task, status: "unknown" } });
			} else {
				await host.resources.release(lease);
				await host.append(session.id, { type: "task", task: { ...task, status: "failed" } });
			}
		}
		if (session.ephemeral && !unreconciled(host.ledger.get(session.id))) await host.forgetEphemeral(session.id);
	}
}

export function recovery(host: RecoveryHost, workspace: string): RecoveryEntry[] {
	const entries: RecoveryEntry[] = [];
	const active = [...host.active.values()].some((execution) => execution.record.workspace === workspace);
	for (const metadata of host.ledger.metadata()) {
		if (metadata.workspace !== workspace && !metadata.natives.some((native) => native.workspace === workspace))
			continue;
		const session = host.ledger.get(metadata.id);
		for (const turn of session.turns.filter((turn) => turn.status === "unknown")) {
			const native = session.natives.find((native) => native.id === turn.nativeRecordId);
			if ((native?.workspace ?? session.workspace) !== workspace) continue;
			const tools = new Map<string, RecoveryEntry["tools"][number]>();
			for (const event of session.events) {
				if (event.data.type !== "runtime" || event.data.turnId !== turn.id) continue;
				const runtime = event.data.event;
				if (runtime.type === "tool_start")
					tools.set(runtime.id, { id: runtime.id, name: runtime.name, input: runtime.input, finished: false });
				if (runtime.type === "tool_end")
					tools.set(runtime.id, {
						...tools.get(runtime.id),
						id: runtime.id,
						name: runtime.name,
						output: runtime.output,
						finished: true,
					});
			}
			entries.push({
				sessionId: session.id,
				name: session.name,
				turnId: turn.id,
				backend: native?.selection.backend,
				nativeId: native?.nativeId,
				active,
				tools: [...tools.values()],
			});
		}
		if (session.workspace !== workspace) continue;
		const edits = new Map(
			session.events.flatMap((event) =>
				event.data.type === "manual_edit" ? [[event.data.operationId, event.data] as const] : [],
			),
		);
		for (const edit of edits.values()) {
			if (edit.status === "unknown")
				entries.push({
					sessionId: session.id,
					name: session.name,
					turnId: `edit:${edit.operationId}`,
					active,
					tools: [],
					manualEdit: edit.path,
				});
		}
	}
	return entries;
}

export async function reconcile(host: RecoveryHost, id: string, turnId: string, description: string): Promise<void> {
	if (host.active.has(id)) throw new Error("Runtime still active");
	if (!description.trim()) throw new Error("Record native execution and effect verification before reconciliation");
	const session = host.ledger.get(id);
	if (turnId.startsWith("edit:")) {
		if ([...host.active.values()].some((execution) => execution.record.workspace === session.workspace))
			throw new Error("Workspace execution still active");
		const operationId = turnId.slice(5);
		const edit = [...session.events]
			.reverse()
			.find((event) => event.data.type === "manual_edit" && event.data.operationId === operationId)?.data;
		if (!edit || edit.type !== "manual_edit" || edit.status !== "unknown")
			throw new Error("Edit does not require reconciliation");
		await host.resources.reconcile(`workspace:${session.workspace}`, [`${id}:edit:${operationId}`]);
		await host.append(id, { type: "manual_edit", operationId, path: edit.path, status: "completed" });
		await host.append(id, {
			type: "recovery",
			description: `Manual edit ${operationId} reconciled: ${description}`,
		});
		return;
	}
	const turn = session.turns.find((turn) => turn.id === turnId);
	if (!turn || turn.status !== "unknown") throw new Error("Turn does not require reconciliation");
	const record = session.natives.find((record) => record.id === turn.nativeRecordId);
	const workspace = record?.workspace ?? session.workspace;
	if ([...host.active.values()].some((execution) => execution.record.workspace === workspace))
		throw new Error("Workspace execution still active");
	const task = session.tasks.find((task) => task.id === turn.taskId);
	if (task?.resource) await host.resources.reconcile(task.resource, [task.id]);
	const remaining = session.turns.filter((entry) => entry.id !== turnId && entry.status === "unknown");
	if (!remaining.length) {
		const owners = session.turns.map((turn) => `${id}:${turn.id}`);
		await host.resources.reconcile(`workspace:${workspace}`, owners);
	}
	await host.append(id, { type: "reconciled", turnId, description });
}

export async function resetNative(host: RecoveryHost, id: string, description: string): Promise<void> {
	const session = host.ledger.get(id);
	if (host.active.has(id) || unreconciled(session))
		throw new Error("Settle and reconcile execution before resetting native sessions");
	if (!description.trim()) throw new Error("Describe why fresh native sessions are required");
	await host.append(id, { type: "branch", branch: randomUUID(), description });
}

export function unreconciled(session: RelaySession): boolean {
	const edits = new Map(
		session.events.flatMap((event) =>
			event.data.type === "manual_edit" ? [[event.data.operationId, event.data.status] as const] : [],
		),
	);
	return (
		session.turns.some((turn) => turn.status === "unknown") ||
		[...edits.values()].some((status) => status !== "completed")
	);
}
