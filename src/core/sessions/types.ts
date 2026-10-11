import type { Handoff } from "../handoffs/types.ts";
import type { Approval } from "../permissions/types.ts";
import type { Backend, ExecutionStatus, NativeRecord, RuntimeEvent, RuntimeSelection } from "../runtimes/types.ts";
import type { DelegatedTask } from "../tasks/types.ts";

export interface ArtifactReference {
	id: string;
	uri: string;
	description: string;
	sha256?: string;
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface AttachmentReference extends ArtifactReference {
	mediaType: ImageMediaType | "text/plain";
	bytes: number;
}

/** Product annotations, independent of native transcripts. Git objects remain in the workspace. */
export interface ProductNote {
	id: string;
	kind: "checkpoint" | "review" | "switch" | "error";
	text: string;
	status?: "running" | "done" | "error";
	snapshot?: string;
	previous?: string;
	files?: string[];
	toolId?: string;
	rootCommit?: boolean;
}

export type LedgerData =
	| {
			type: "created";
			workspace: string;
			selection: RuntimeSelection;
			name: string;
			parentSessionId?: string;
			purpose?: "review" | "branch";
			ephemeral?: boolean;
	  }
	| { type: "selection"; selection: RuntimeSelection }
	| { type: "workspace"; workspace: string; branch: string }
	| { type: "native"; record: NativeRecord }
	| { type: "user"; turnId: string; text: string; attachments?: AttachmentReference[] }
	| { type: "attachment"; attachment: AttachmentReference }
	| { type: "turn"; turnId: string; nativeRecordId: string; taskId?: string; status: ExecutionStatus }
	| { type: "runtime"; turnId: string; nativeRecordId: string; taskId?: string; event: RuntimeEvent }
	| { type: "handoff"; nativeRecordId: string; handoff: Handoff; status: "prepared" | "acknowledged" }
	| { type: "approval"; approval: Approval }
	| { type: "task"; task: DelegatedTask }
	| {
			type: "import";
			source: string;
			messages: { id: string; role: "user" | "assistant"; text: string; attachments?: AttachmentReference[] }[];
			outcomes: Handoff["completedOutcomes"];
			artifacts?: ArtifactReference[];
	  }
	| {
			type: "manual_edit";
			operationId: string;
			path: string;
			status: "prepared" | "completed" | "unknown";
			sha256?: string;
	  }
	| { type: "branch"; branch: string; description: string }
	| { type: "note"; note: ProductNote }
	| { type: "recovery"; description: string }
	| { type: "reconciled"; turnId: string; description: string }
	| { type: "ephemeral_marker"; eventType: string };

export interface LedgerEvent {
	version: 1;
	id: string;
	sessionId: string;
	sequence: number;
	time: number;
	data: LedgerData;
}

export interface RelaySession {
	id: string;
	parentSessionId?: string;
	purpose?: "review" | "branch";
	/** Conversation stays in memory; execution metadata survives crashes for reconciliation. */
	ephemeral?: boolean;
	name: string;
	workspace: string;
	branch: string;
	selection: RuntimeSelection;
	updated: number;
	natives: NativeRecord[];
	tasks: DelegatedTask[];
	approvals: Approval[];
	turns: { id: string; nativeRecordId: string; taskId?: string; status: ExecutionStatus }[];
	events: LedgerEvent[];
}

export interface RecoveryEntry {
	sessionId: string;
	name: string;
	turnId: string;
	backend?: Backend;
	nativeId?: string;
	active: boolean;
	tools: { id: string; name: string; finished: boolean; input?: unknown; output?: unknown }[];
	manualEdit?: string;
}
