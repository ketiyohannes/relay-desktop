export type PermissionMode = "ask" | "auto-approve" | "full-access" | "read-only";

export interface Approval {
	id: string;
	nativeRecordId: string;
	turnId: string;
	taskId?: string;
	tool: string;
	input: unknown;
	expiresAt: number;
	status: "pending" | "allowed" | "denied" | "expired" | "interrupted";
}
