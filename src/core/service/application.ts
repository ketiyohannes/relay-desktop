import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { ApprovalManager } from "../permissions/approvals.ts";
import type { Approval, PermissionMode } from "../permissions/types.ts";
import { type ResourceLease, ResourceLeases } from "../resources/leases.ts";
import type {
	Backend,
	Capability,
	ExecutionStatus,
	RuntimeAdapter,
	RuntimeConnection,
	RuntimeSelection,
} from "../runtimes/types.ts";
import { ArtifactStore } from "../sessions/artifacts.ts";
import {
	createExecution,
	type Execution,
	type ExecutionHost,
	execute,
	interruptExecution,
} from "../sessions/execution.ts";
import { SessionLedger } from "../sessions/ledger.ts";

import {
	type RecoveryHost,
	reconcile,
	recoverRestart,
	recovery,
	resetNative,
	unreconciled,
} from "../sessions/recovery.ts";
import type {
	AttachmentReference,
	LedgerData,
	LedgerEvent,
	ProductNote,
	RecoveryEntry,
	RelaySession,
} from "../sessions/types.ts";

import { delegate } from "../tasks/delegation.ts";
import type { DelegationRequest, DelegationResult, WorkerProfile } from "../tasks/types.ts";
import { loadWorkers } from "../tasks/workers.ts";
import { edit } from "../workspace/edits.ts";

import type { EditorFile } from "../workspace/types.ts";
import { validateImport, validateSelection } from "./protocol.ts";

export class RelayApplication {
	private readonly approvals: ApprovalManager;
	readonly ledger: SessionLedger;
	readonly resources: ResourceLeases;
	readonly directory: string;
	readonly artifacts: ArtifactStore;
	private readonly adapters: Map<Backend, RuntimeAdapter>;
	private readonly active = new Map<string, Execution>();
	private readonly listeners = new Set<(event: LedgerEvent) => void>();
	private readonly settlementMs: number;
	private workers: WorkerProfile[] = [];
	private readonly creating = new Map<string, Promise<RelaySession>>();
	private readonly noteQueue = new Map<string, Promise<void>>();
	private readonly importQueue = new Map<string, Promise<void>>();
	constructor(directory: string, adapters: RuntimeAdapter[], settlementMs = 10000) {
		this.settlementMs = settlementMs;
		this.directory = directory;
		this.artifacts = new ArtifactStore(join(directory, "artifacts"));
		this.ledger = new SessionLedger(join(directory, "ledger"));
		this.resources = new ResourceLeases(join(directory, "resources"));
		this.adapters = new Map(adapters.map((adapter) => [adapter.backend, adapter]));
		this.approvals = new ApprovalManager({
			ledger: this.ledger,
			settlementMs,
			append: (id, data) => this.append(id, data),
			findExecution: (id, recordId) => this.findExecution(id, recordId),
		});
	}
	async initialize(): Promise<void> {
		await this.ledger.load();
		this.workers = await loadWorkers(this.directory);
		await recoverRestart(this.recoveryHost());
	}
	subscribe(listener: (event: LedgerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	importHistory(id: string, data: Extract<LedgerData, { type: "import" }>): Promise<void> {
		const captured = validateImport(data);
		const operation = (this.importQueue.get(id) ?? Promise.resolve()).then(async () => {
			for (const message of captured.messages) {
				for (const attachment of message.attachments ?? []) {
					const known = this.ledger
						.get(id)
						.events.find(
							(event) => event.data.type === "attachment" && event.data.attachment.id === attachment.id,
						)?.data;
					if (
						!known ||
						known.type !== "attachment" ||
						known.attachment.uri !== attachment.uri ||
						known.attachment.sha256 !== attachment.sha256 ||
						known.attachment.mediaType !== attachment.mediaType ||
						known.attachment.bytes !== attachment.bytes
					)
						throw new Error("Import attachments must be captured in this Relay session first");
					await this.artifacts.resolve(id, attachment);
				}
			}
			if (
				this.ledger
					.get(id)
					.events.some((event) => event.data.type === "import" && event.data.source === captured.source)
			)
				return;
			await this.append(id, captured);
		});
		this.importQueue.set(
			id,
			operation.catch(() => {}),
		);
		return operation;
	}
	async append(sessionId: string, data: LedgerData): Promise<LedgerEvent> {
		const event = await this.ledger.append(sessionId, data);
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				/* A disconnected frontend cannot interrupt durable recording. */
			}
		}
		return event;
	}
	create(
		workspace: string,
		selection: RuntimeSelection,
		name = "Untitled session",
		id: string = randomUUID(),
		parentSessionId?: string,
		ephemeral = false,
		purpose?: "review" | "branch",
	): Promise<RelaySession> {
		if (this.ledger.has(id)) return Promise.resolve(this.ledger.get(id));
		const existing = this.creating.get(id);
		if (existing) return existing;
		const operation = (async () => {
			if (parentSessionId) this.ledger.get(parentSessionId);
			await this.append(id, {
				type: "created",
				workspace: await realpath(workspace),
				selection: validateSelection(selection),
				name,
				parentSessionId,
				ephemeral,
				purpose,
			});
			return this.ledger.get(id);
		})();
		this.creating.set(id, operation);
		void operation.finally(() => this.creating.delete(id)).catch(() => {});
		return operation;
	}
	recordNote(id: string, note: ProductNote): Promise<void> {
		if (
			typeof note.id !== "string" ||
			typeof note.text !== "string" ||
			!["checkpoint", "review", "switch", "error"].includes(note.kind)
		)
			return Promise.reject(new Error("Invalid product note"));
		if (note.status !== undefined && !["running", "done", "error"].includes(note.status))
			return Promise.reject(new Error("Invalid note status"));
		if (note.snapshot !== undefined && !/^[0-9a-f]{40,64}$/.test(note.snapshot))
			return Promise.reject(new Error("Invalid snapshot reference"));
		if (note.previous !== undefined && !/^[0-9a-f]{40,64}$/.test(note.previous))
			return Promise.reject(new Error("Invalid previous snapshot reference"));
		if (note.files !== undefined && (!Array.isArray(note.files) || note.files.some((path) => typeof path !== "string")))
			return Promise.reject(new Error("Invalid note files"));
		const captured: ProductNote = {
			id: note.id,
			kind: note.kind,
			text: note.text,
			...(note.status ? { status: note.status } : {}),
			...(note.snapshot ? { snapshot: note.snapshot } : {}),
			...(note.previous ? { previous: note.previous } : {}),
			...(note.files ? { files: [...note.files] } : {}),
			...(typeof note.toolId === "string" ? { toolId: note.toolId } : {}),
			...(typeof note.rootCommit === "boolean" ? { rootCommit: note.rootCommit } : {}),
		};
		const operation = (this.noteQueue.get(id) ?? Promise.resolve()).then(async () => {
			const previous = [...this.ledger.get(id).events]
				.reverse()
				.find((event) => event.data.type === "note" && event.data.note.id === captured.id);
			if (previous?.data.type === "note" && JSON.stringify(previous.data.note) === JSON.stringify(captured)) return;
			await this.append(id, { type: "note", note: captured });
		});
		this.noteQueue.set(
			id,
			operation.catch(() => {}),
		);
		return operation;
	}
	async select(id: string, selection: RuntimeSelection): Promise<void> {
		if (this.active.has(id)) throw new Error("Cancel and wait for execution to settle before switching runtime");
		selection = validateSelection(selection);
		if (JSON.stringify(this.ledger.get(id).selection) === JSON.stringify(selection)) return;
		await this.append(id, { type: "selection", selection });
	}
	async forgetEphemeral(id: string): Promise<void> {
		const session = this.ledger.get(id);
		if (!session.ephemeral || this.active.has(id) || unreconciled(session))
			throw new Error("Settle and reconcile ephemeral execution before forgetting it");
		await this.ledger.forgetEphemeral(id);
	}
	async changeWorkspace(id: string, workspace: string): Promise<void> {
		if (this.active.has(id)) throw new Error("Execution still active");
		if (unreconciled(this.ledger.get(id))) throw new Error("Reconcile interrupted execution before changing workspace");
		await this.append(id, { type: "workspace", workspace: await realpath(workspace), branch: randomUUID() });
	}
	async capabilities(selection: RuntimeSelection): Promise<Capability> {
		selection = validateSelection(selection);
		const adapter = this.adapters.get(selection.backend);
		if (!adapter) throw new Error(`Runtime unavailable: ${selection.backend}`);
		return adapter.discover(selection);
	}

	async attach(
		id: string,
		mediaType: AttachmentReference["mediaType"],
		data: string,
		description: string,
	): Promise<AttachmentReference> {
		if (this.ledger.get(id).ephemeral)
			throw new Error(
				"Durable attachments are unavailable for ephemeral Relay sessions; native pi attachments remain supported",
			);
		if (typeof data !== "string" || typeof description !== "string" || description.includes("\0"))
			throw new Error("Invalid attachment");
		const attachment = await this.artifacts.capture(id, mediaType, data, description);
		await this.append(id, { type: "attachment", attachment });
		return attachment;
	}
	async copyAttachment(id: string, sourceSessionId: string, attachmentId: string): Promise<AttachmentReference> {
		const source = this.ledger
			.get(sourceSessionId)
			.events.find((event) => event.data.type === "attachment" && event.data.attachment.id === attachmentId)?.data;
		if (!source || source.type !== "attachment") throw new Error("Unknown source attachment");
		const artifact = await this.artifacts.resolve(sourceSessionId, source.attachment);
		return this.attach(
			id,
			source.attachment.mediaType,
			(await readFile(artifact.path)).toString("base64"),
			source.attachment.description,
		);
	}
	/** Client operation IDs deduplicate submissions, including after reconnect/restart. */
	async submit(
		id: string,
		text: string,
		permissionMode: PermissionMode = "ask",
		turnId: string = randomUUID(),
		hosted?: { connection: RuntimeConnection; nativeFile?: string },
		reserved?: () => void,
		attachmentIds: string[] = [],
	): Promise<ExecutionStatus> {
		if (!/^[a-zA-Z0-9_-]{1,160}$/.test(turnId)) throw new Error("Invalid turn operation ID");
		if (!text.trim()) throw new Error("Enter a prompt");
		const session = this.ledger.get(id);
		const previous = session.turns.find((turn) => turn.id === turnId);
		if (previous) return previous.status;
		if (this.active.has(id)) throw new Error("Session already running");
		if (unreconciled(session)) throw new Error("Reconcile interrupted execution before continuing");
		if (this.ledger.workspaceBlocked(session.workspace))
			throw new Error("Workspace has unreconciled execution in another session");
		const selectionKey = JSON.stringify(session.selection);
		let record = [...session.natives]
			.reverse()
			.find(
				(native) =>
					native.role === "foreground" &&
					native.branch === session.branch &&
					native.workspace === session.workspace &&
					native.status === "available" &&
					JSON.stringify(native.selection) === selectionKey,
			);
		if (session.ephemeral && !hosted) record = undefined;
		if (!record)
			record = {
				id: randomUUID(),
				selection: session.selection,
				workspace: session.workspace,
				branch: session.branch,
				role: session.purpose === "review" ? "review" : "foreground",
				parentNativeId: session.parentSessionId
					? this.ledger
							.get(session.parentSessionId)
							.natives.filter((native) => native.role === "foreground")
							.at(-1)?.id
					: undefined,
				receivedThrough: 0,
				status: "available",
			};
		if (hosted && record.nativeId && record.nativeId !== hosted.connection.nativeId)
			record = {
				...record,
				id: randomUUID(),
				nativeId: hosted.connection.nativeId,
				nativeFile: hosted.nativeFile,
				receivedThrough: 0,
			};
		if (hosted) {
			record.nativeId = hosted.connection.nativeId;
			record.nativeFile = hosted.nativeFile;
			// Model changes within the same public pi journal retain its synchronization coverage.
			record.receivedThrough = Math.max(
				record.receivedThrough,
				...session.natives
					.filter(
						(native) =>
							native.nativeId === record.nativeId &&
							native.workspace === record.workspace &&
							native.branch === record.branch,
					)
					.map((native) => native.receivedThrough),
			);
		}
		const execution = createExecution(id, record, permissionMode, turnId);
		execution.connection = hosted?.connection;
		// Reserve synchronously before awaiting the resource lock.
		this.active.set(id, execution);
		let lease: ResourceLease | undefined;
		try {
			reserved?.();
			if (
				!Array.isArray(attachmentIds) ||
				attachmentIds.length > 8 ||
				attachmentIds.some((entry) => typeof entry !== "string")
			)
				throw new Error("Attach at most 8 files per turn");
			for (const attachmentId of new Set(attachmentIds)) {
				const reference = session.events.find(
					(event) => event.data.type === "attachment" && event.data.attachment.id === attachmentId,
				)?.data;
				if (!reference || reference.type !== "attachment") throw new Error("Unknown session attachment");
				execution.attachments.push(await this.artifacts.resolve(id, reference.attachment));
			}
			lease = await this.resources.acquire(`workspace:${session.workspace}`, `${id}:${turnId}`);
			await this.append(id, { type: "native", record });
			await this.append(id, {
				type: "user",
				turnId,
				text,
				...(execution.attachments.length
					? { attachments: execution.attachments.map((attachment) => attachment.reference) }
					: {}),
			});
			await this.execute(execution, text);
		} finally {
			try {
				if (lease && execution.status !== "unknown") await this.resources.release(lease);
			} catch {
				execution.status = "unknown";
				await this.append(id, { type: "turn", turnId, nativeRecordId: record.id, status: "unknown" });
			} finally {
				this.active.delete(id);
				execution.finish();
			}
		}
		return execution.status;
	}

	private findExecution(id: string, recordId: string): Execution | undefined {
		const parent = this.active.get(id);
		if (parent?.record.id === recordId) return parent;
		return [...(parent?.children ?? [])].find((child) => child.record.id === recordId);
	}

	private cancelExecution(execution: Execution): Promise<"requested" | "unsupported" | "unknown"> {
		execution.cancellation ??= interruptExecution(
			{
				settlementMs: this.settlementMs,
				closeApprovals: (entry) => this.approvals.closeApprovals(entry),
				cancelExecution: (entry) => this.cancelExecution(entry),
			},
			execution,
		);
		return execution.cancellation;
	}

	async cancel(id: string, turnId?: string): Promise<"requested" | "unsupported" | "unknown" | "idle"> {
		const execution = this.active.get(id);
		if (!execution || (turnId && turnId !== execution.turnId)) return "idle";
		return this.cancelExecution(execution);
	}
	async wait(id: string): Promise<void> {
		await this.active.get(id)?.settled;
	}
	async delegateHosted(id: string, turnId: string, request: DelegationRequest): Promise<DelegationResult> {
		const execution = this.active.get(id);
		if (!execution || execution.turnId !== turnId) throw new Error("Hosted turn inactive");
		return this.delegate(execution, request, new AbortController().signal);
	}
	async shutdown(): Promise<void> {
		await Promise.all(
			[...this.active.keys()].map(async (id) => {
				await this.cancel(id);
				await this.wait(id);
			}),
		);
	}
	activeSessions(): string[] {
		return [...this.active.keys()];
	}

	private recoveryHost(): RecoveryHost {
		return {
			ledger: this.ledger,
			resources: this.resources,
			active: this.active,
			append: (id, data) => this.append(id, data),
			forgetEphemeral: (id) => this.forgetEphemeral(id),
		};
	}
	private executionHost(): ExecutionHost {
		return {
			directory: this.directory,
			ledger: this.ledger,
			artifacts: this.artifacts,
			adapters: this.adapters,
			workers: this.workers,
			settlementMs: this.settlementMs,
			append: (id, data) => this.append(id, data),
			delegate: (parent, request, signal) => this.delegate(parent, request, signal),
			approval: (entry, event, taskId) => this.approvals.approval(entry, event, taskId),
			closeApprovals: (entry) => this.approvals.closeApprovals(entry),
			cancelExecution: (entry) => this.cancelExecution(entry),
		};
	}
	private execute(execution: Execution, text: string, taskId?: string): Promise<void> {
		return execute(this.executionHost(), execution, text, taskId);
	}
	private delegate(parent: Execution, request: DelegationRequest, signal: AbortSignal): Promise<DelegationResult> {
		return delegate(
			{
				workers: this.workers,
				resources: this.resources,
				ledger: this.ledger,
				append: (id, data) => this.append(id, data),
				execute: (entry, text, taskId) => this.execute(entry, text, taskId),
				cancelExecution: (entry) => this.cancelExecution(entry),
			},
			parent,
			request,
			signal,
		);
	}
	respond(id: string, approvalId: string, allowed: boolean, status?: Approval["status"]): Promise<void> {
		return this.approvals.respond(id, approvalId, allowed, status);
	}
	recovery(workspace: string): RecoveryEntry[] {
		return recovery(this.recoveryHost(), workspace);
	}
	reconcile(id: string, turnId: string, description: string): Promise<void> {
		return reconcile(this.recoveryHost(), id, turnId, description);
	}
	resetNative(id: string, description: string): Promise<void> {
		return resetNative(this.recoveryHost(), id, description);
	}
	edit(id: string, operationId: string, path: string, expected: string, content: string): Promise<EditorFile> {
		return edit(
			{ ledger: this.ledger, resources: this.resources, append: (sessionId, data) => this.append(sessionId, data) },
			id,
			operationId,
			path,
			expected,
			content,
		);
	}
}
