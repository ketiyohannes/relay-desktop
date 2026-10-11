import type { Handoff } from "../handoffs/types.ts";
import type { PermissionMode } from "../permissions/types.ts";
import type { ArtifactReference, AttachmentReference } from "../sessions/types.ts";
import type { DelegationRequest, DelegationResult, WorkerReport } from "../tasks/types.ts";

export type Backend = "codex" | "claude" | "pi";

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

export interface RuntimeAttachment {
	reference: AttachmentReference;
	path: string;
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
