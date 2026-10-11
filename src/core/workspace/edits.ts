import { createHash } from "node:crypto";

import type { ResourceLeases } from "../resources/leases.ts";

import type { SessionLedger } from "../sessions/ledger.ts";

import type { LedgerData, LedgerEvent } from "../sessions/types.ts";

import { saveEditorFile } from "./save-file.ts";
import type { EditorFile } from "./types.ts";

export interface EditHost {
	ledger: SessionLedger;
	resources: ResourceLeases;
	append(sessionId: string, data: LedgerData): Promise<LedgerEvent>;
}

export async function edit(
	host: EditHost,
	id: string,
	operationId: string,
	path: string,
	expected: string,
	content: string,
): Promise<EditorFile> {
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(operationId)) throw new Error("Invalid edit operation ID");
	const session = host.ledger.get(id);
	if (session.events.some((event) => event.data.type === "manual_edit" && event.data.operationId === operationId))
		throw new Error("Edit already recorded; inspect file contents before another save");
	if (host.ledger.workspaceBlocked(session.workspace)) throw new Error("Workspace requires reconciliation");
	const lease = await host.resources.acquire(`workspace:${session.workspace}`, `${id}:edit:${operationId}`);
	let recorded = false;
	try {
		await host.append(id, { type: "manual_edit", operationId, path, status: "prepared" });
		recorded = true;
		const file = await saveEditorFile(session.workspace, path, expected, content);
		await host.append(id, {
			type: "manual_edit",
			operationId,
			path,
			status: "completed",
			sha256: createHash("sha256").update(content).digest("hex"),
		});
		await host.resources.release(lease);
		return file;
	} catch (error) {
		if (recorded) await host.append(id, { type: "manual_edit", operationId, path, status: "unknown" });
		throw error;
	} finally {
		if (!recorded) await host.resources.release(lease);
	}
}
