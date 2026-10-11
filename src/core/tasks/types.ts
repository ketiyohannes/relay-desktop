import type { PermissionMode } from "../permissions/types.ts";
import type { ExecutionStatus, RuntimeSelection } from "../runtimes/types.ts";
import type { ArtifactReference } from "../sessions/types.ts";

export interface DelegationResult {
	status: ExecutionStatus | "blocked";
	summary: string;
	findings: string[];
	evidence: ArtifactReference[];
	actions: { description: string; effect: "none" | "completed" | "unknown" }[];
	finalEnvironment: { workspace: string; resource?: string; state: string };
	blockers: string[];
	pendingApprovalIds: string[];
}

export type WorkerReport = Pick<DelegationResult, "summary" | "findings" | "evidence" | "actions" | "blockers"> & {
	environmentState: string;
};

export interface DelegatedTask {
	id: string;
	parentTurnId: string;
	parentNativeId: string;
	nativeRecordId?: string;
	objective: string;
	resource?: string;
	permissionMode: PermissionMode;
	status: ExecutionStatus | "blocked";
	result?: DelegationResult;
}

export interface DelegationRequest {
	selection?: Exclude<RuntimeSelection, { backend: "pi" }>;
	workerId?: string;
	objective: string;
	resource?: string;
	permissionMode?: PermissionMode;
}

export interface WorkerProfile {
	id: string;
	description: string;
	selection: Exclude<RuntimeSelection, { backend: "pi" }>;
	/** Exclusive control of configured browser/desktop infrastructure. */
	resource: string;
}
