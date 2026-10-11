import { Type } from "typebox";
import { Check } from "typebox/value";
import type { LedgerEvent } from "../contracts.ts";
import { validateSelection } from "../service/protocol.ts";

const text = Type.String({ pattern: "^[^\\u0000]*$" });
const id = Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000]*$" });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const strings = Type.Array(text);
const status = Type.Union([
	Type.Literal("running"),
	Type.Literal("completed"),
	Type.Literal("cancelled"),
	Type.Literal("failed"),
	Type.Literal("unknown"),
]);
const taskStatus = Type.Union([status, Type.Literal("blocked")]);
const artifact = Type.Object({
	id,
	uri: id,
	description: text,
	sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
});
const attachment = Type.Intersect([
	artifact,
	Type.Object({
		mediaType: Type.Union([
			Type.Literal("image/png"),
			Type.Literal("image/jpeg"),
			Type.Literal("image/gif"),
			Type.Literal("image/webp"),
			Type.Literal("text/plain"),
		]),
		bytes: Type.Integer({ minimum: 1, maximum: 10 * 1024 * 1024 }),
		sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	}),
]);
const actions = Type.Array(
	Type.Object({
		description: text,
		effect: Type.Union([Type.Literal("none"), Type.Literal("completed"), Type.Literal("unknown")]),
	}),
);
const report = { summary: text, findings: strings, evidence: Type.Array(artifact), actions, blockers: strings };
const result = Type.Object({
	...report,
	status: taskStatus,
	finalEnvironment: Type.Object({ workspace: id, resource: Type.Optional(id), state: text }),
	pendingApprovalIds: Type.Array(id),
});
const outcomes = Type.Array(
	Type.Object({
		eventId: id,
		tool: text,
		outcome: text,
		effect: Type.Union([Type.Literal("completed"), Type.Literal("unknown")]),
	}),
);
const messages = Type.Array(
	Type.Object({
		id,
		role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
		text,
		attachments: Type.Optional(Type.Array(attachment)),
	}),
);
const native = Type.Object({
	id,
	selection: Type.Unknown(),
	nativeId: Type.Optional(id),
	nativeFile: Type.Optional(id),
	workspace: id,
	branch: id,
	role: Type.Union([Type.Literal("foreground"), Type.Literal("worker"), Type.Literal("review")]),
	parentNativeId: Type.Optional(id),
	taskId: Type.Optional(id),
	receivedThrough: count,
	status: Type.Union([Type.Literal("available"), Type.Literal("missing"), Type.Literal("unknown")]),
});
const approval = Type.Object({
	id,
	nativeRecordId: id,
	turnId: id,
	taskId: Type.Optional(id),
	tool: text,
	input: Type.Unknown(),
	expiresAt: count,
	status: Type.Union([
		Type.Literal("pending"),
		Type.Literal("allowed"),
		Type.Literal("denied"),
		Type.Literal("expired"),
		Type.Literal("interrupted"),
	]),
});
const task = Type.Object({
	id,
	parentTurnId: id,
	parentNativeId: id,
	nativeRecordId: Type.Optional(id),
	objective: text,
	resource: Type.Optional(id),
	permissionMode: Type.Union([
		Type.Literal("ask"),
		Type.Literal("auto-approve"),
		Type.Literal("full-access"),
		Type.Literal("read-only"),
	]),
	status: taskStatus,
	result: Type.Optional(result),
});
const runtime = Type.Union([
	Type.Object({ type: Type.Literal("accepted"), nativeTurnId: Type.Optional(id) }),
	Type.Object({ type: Type.Literal("native_session"), nativeId: id }),
	Type.Object({ type: Type.Literal("text"), id, text, complete: Type.Boolean() }),
	Type.Object({ type: Type.Literal("tool_start"), id, name: text, input: Type.Unknown() }),
	Type.Object({ type: Type.Literal("tool_progress"), id, text }),
	Type.Object({ type: Type.Literal("tool_end"), id, name: text, output: Type.Unknown(), failed: Type.Boolean() }),
	Type.Object({ type: Type.Literal("approval"), id, tool: text, input: Type.Unknown() }),
	Type.Object({ type: Type.Literal("artifact"), artifact }),
	Type.Object({ type: Type.Literal("usage"), usage: Type.Record(Type.String(), Type.Number({ minimum: 0 })) }),
	Type.Object({ type: Type.Literal("compaction"), description: text }),
	Type.Object({ type: Type.Literal("worker_result"), report: Type.Object({ ...report, environmentState: text }) }),
	Type.Object({
		type: Type.Literal("done"),
		status: Type.Union([
			Type.Literal("completed"),
			Type.Literal("cancelled"),
			Type.Literal("failed"),
			Type.Literal("unknown"),
		]),
		error: Type.Optional(text),
		quotaExhausted: Type.Optional(Type.Boolean()),
	}),
]);
const data = Type.Union([
	Type.Object({
		type: Type.Literal("created"),
		workspace: id,
		selection: Type.Unknown(),
		name: text,
		parentSessionId: Type.Optional(id),
		purpose: Type.Optional(Type.Union([Type.Literal("review"), Type.Literal("branch")])),
		ephemeral: Type.Optional(Type.Boolean()),
	}),
	Type.Object({ type: Type.Literal("selection"), selection: Type.Unknown() }),
	Type.Object({ type: Type.Literal("workspace"), workspace: id, branch: id }),
	Type.Object({ type: Type.Literal("native"), record: native }),
	Type.Object({ type: Type.Literal("user"), turnId: id, text, attachments: Type.Optional(Type.Array(attachment)) }),
	Type.Object({ type: Type.Literal("attachment"), attachment }),
	Type.Object({ type: Type.Literal("turn"), turnId: id, nativeRecordId: id, taskId: Type.Optional(id), status }),
	Type.Object({
		type: Type.Literal("runtime"),
		turnId: id,
		nativeRecordId: id,
		taskId: Type.Optional(id),
		event: runtime,
	}),
	Type.Object({
		type: Type.Literal("handoff"),
		nativeRecordId: id,
		status: Type.Union([Type.Literal("prepared"), Type.Literal("acknowledged")]),
		handoff: Type.Object({
			version: Type.Literal(1),
			id,
			through: count,
			objective: text,
			constraints: strings,
			conversation: Type.Array(
				Type.Object({ eventId: id, role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]), text }),
			),
			decisions: strings,
			unresolved: strings,
			completedOutcomes: outcomes,
			artifacts: Type.Array(artifact),
			workspace: id,
			tasks: Type.Array(Type.Object({ id, status: text, summary: Type.Optional(text) })),
			omittedEvents: count,
		}),
	}),
	Type.Object({ type: Type.Literal("approval"), approval }),
	Type.Object({ type: Type.Literal("task"), task }),
	Type.Object({
		type: Type.Literal("import"),
		source: id,
		messages,
		outcomes,
		artifacts: Type.Optional(Type.Array(artifact)),
	}),
	Type.Object({
		type: Type.Literal("manual_edit"),
		operationId: id,
		path: id,
		status: Type.Union([Type.Literal("prepared"), Type.Literal("completed"), Type.Literal("unknown")]),
		sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
	}),
	Type.Object({ type: Type.Literal("branch"), branch: id, description: text }),
	Type.Object({
		type: Type.Literal("note"),
		note: Type.Object({
			id,
			kind: Type.Union([
				Type.Literal("checkpoint"),
				Type.Literal("review"),
				Type.Literal("switch"),
				Type.Literal("error"),
			]),
			text,
			status: Type.Optional(Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("error")])),
			snapshot: Type.Optional(id),
			previous: Type.Optional(id),
			files: Type.Optional(strings),
			toolId: Type.Optional(id),
			rootCommit: Type.Optional(Type.Boolean()),
		}),
	}),
	Type.Object({ type: Type.Literal("recovery"), description: text }),
	Type.Object({ type: Type.Literal("reconciled"), turnId: id, description: text }),
	Type.Object({
		type: Type.Literal("ephemeral_marker"),
		eventType: Type.String({ enum: ["user", "attachment", "runtime", "handoff", "import", "note", "recovery"] }),
	}),
]);
const envelope = Type.Object({
	version: Type.Literal(1),
	id,
	sessionId: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,160}$" }),
	sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	time: count,
	data,
});

/** Validate disk input before typed recovery and projection can consume it. */
export function validateLedgerEvent(value: unknown): LedgerEvent {
	if (!Check(envelope, value)) throw new Error("Invalid journal payload or envelope");
	const event = value as LedgerEvent;
	if (event.data.type === "created" || event.data.type === "selection") validateSelection(event.data.selection);
	if (event.data.type === "native") validateSelection(event.data.record.selection);
	return event;
}
