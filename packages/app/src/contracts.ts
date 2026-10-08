/** Relay product contracts. Native SDK/protocol objects stay inside adapters. */
export type Backend = "codex" | "claude" | "pi";
export type PermissionMode = "ask" | "auto-edit" | "read-only";
export type ExecutionStatus = "running" | "completed" | "cancelled" | "failed" | "unknown";

export interface McpServer {
	command: string;
	args: string[];
	/** Environment variable names only. Values are resolved outside the ledger. */
	envKeys?: string[];
}

export type RuntimeSelection =
	| {
			backend: "codex";
			profile: string;
			model: string;
			options?: { effort?: "low" | "medium" | "high" | "xhigh"; mcp?: Record<string, McpServer> };
	  }
	| {
			backend: "claude";
			profile: string;
			model: string;
			options?: { projectInstructions?: boolean; mcp?: Record<string, McpServer>; maxTurns?: number };
	  }
	| {
			backend: "pi";
			profile: string;
			model: string;
			options: { provider: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" };
	  };

export interface Capability {
	resume: boolean;
	cancel: "interrupt" | "abort" | "unsupported";
	approvals: "native" | "tool-hook" | "unsupported";
	compaction: "native" | "unsupported";
	tools: string[];
	mcp: boolean;
	limitations: string[];
}

export interface NativeRecord {
	id: string;
	selection: RuntimeSelection;
	nativeId?: string;
	/** Opaque public pi SessionManager journal location for a frontend-hosted runtime. */
	nativeFile?: string;
	workspace: string;
	branch: string;
	role: "foreground" | "worker" | "review";
	parentNativeId?: string;
	taskId?: string;
	/** Event sequence acknowledged by this runtime; tied to branch/workspace. */
	receivedThrough: number;
	status: "available" | "missing" | "unknown";
}

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
export interface RuntimeAttachment {
	reference: AttachmentReference;
	path: string;
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

/** No foreign tool calls, credentials, reasoning, or native request objects. */
export interface Handoff {
	version: 1;
	id: string;
	through: number;
	objective: string;
	constraints: string[];
	conversation: { eventId: string; role: "user" | "assistant"; text: string }[];
	decisions: string[];
	unresolved: string[];
	completedOutcomes: { eventId: string; tool: string; outcome: string; effect: "completed" | "unknown" }[];
	artifacts: ArtifactReference[];
	workspace: string;
	tasks: { id: string; status: string; summary?: string }[];
	omittedEvents: number;
}

export type RuntimeEvent =
	| { type: "accepted"; nativeTurnId?: string }
	| { type: "native_session"; nativeId: string }
	| { type: "text"; id: string; text: string; complete: boolean }
	| { type: "tool_start"; id: string; name: string; input: unknown }
	| { type: "tool_progress"; id: string; text: string }
	| { type: "tool_end"; id: string; name: string; output: unknown; failed: boolean }
	| { type: "approval"; id: string; tool: string; input: unknown }
	| { type: "artifact"; artifact: ArtifactReference }
	| { type: "usage"; usage: Record<string, number> }
	| { type: "compaction"; description: string }
	| { type: "worker_result"; report: WorkerReport }
	| { type: "done"; status: Exclude<ExecutionStatus, "running">; error?: string; quotaExhausted?: boolean };

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

export interface TurnInput {
	id: string;
	text: string;
	handoff?: Handoff;
	permissionMode: PermissionMode;
	attachments?: RuntimeAttachment[];
	historyPath?: string;
	readPaths?: string[];
}

export interface OpenInput {
	record: NativeRecord;
	nativeDirectory: string;
	permissionMode: PermissionMode;
	persist?: boolean;
	/** Tools run through Relay, never through a second Relay agent loop. */
	delegate?: (request: DelegationRequest, signal: AbortSignal) => Promise<DelegationResult>;
	workers?: { id: string; description: string; backend: "codex" | "claude" }[];
	/** Public product evidence snapshot; native file-reading tools can retrieve older context. */
	historyPath?: string;
	readPaths?: string[];
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

export interface RuntimeConnection {
	readonly nativeId?: string;
	submit(input: TurnInput, emit: (event: RuntimeEvent) => Promise<void>): Promise<void>;
	respond(approvalId: string, allowed: boolean): Promise<"sent" | "unsupported" | "expired">;
	cancel(): Promise<"requested" | "unsupported" | "unknown">;
	/** Settled means the runtime and its tracked tasks can no longer act. */
	release(): Promise<"settled" | "unknown">;
}

export interface RuntimeAdapter {
	readonly backend: Backend;
	discover(selection: RuntimeSelection): Promise<Capability>;
	open(input: OpenInput): Promise<RuntimeConnection>;
}
