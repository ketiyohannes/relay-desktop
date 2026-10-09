import { randomUUID } from "node:crypto";
import type { SessionManager, SessionStartEvent } from "pi-sdk";
import type {
	ArtifactReference,
	AttachmentReference,
	Handoff,
	LedgerData,
	RelaySession,
	RuntimeSelection,
} from "../contracts.ts";
import type { RelayClient } from "../service/client.ts";
import { imageMediaType } from "../sessions/artifacts.ts";

type NativeManager = Pick<SessionManager, "getSessionId" | "getCwd" | "getSessionName" | "getBranch" | "getLeafId">;

/** Native navigation creates/resolves product identities without translating executable tool calls. */
export class TerminalSessions {
	private readonly client: Pick<RelayClient, "request">;
	private current: string;
	private initial = true;
	private readonly preferInitial: boolean;
	readonly ephemeralIds = new Set<string>();
	constructor(client: Pick<RelayClient, "request">, initialId: string, preferInitial = false) {
		this.client = client;
		this.current = initialId;
		this.preferInitial = preferInitial;
	}
	get sessionId(): string {
		return this.current;
	}
	async resolve(
		manager: NativeManager,
		reason: SessionStartEvent["reason"] = "startup",
	): Promise<{ id: string; parentSessionId?: string; purpose?: "branch" }> {
		if (this.initial) {
			this.initial = false;
			if (!this.preferInitial) {
				const sessions = (await this.client.request({ type: "list" })) as RelaySession[];
				const existing = sessions.find(
					(session) =>
						!session.ephemeral &&
						session.natives.some(
							(native) =>
								native.selection.backend === "pi" &&
								native.nativeId === manager.getSessionId() &&
								native.workspace === manager.getCwd(),
						),
				);
				const branchId = nativeProductSession(manager);
				const branch = sessions.find((session) => session.id === branchId && session.workspace === manager.getCwd());
				if (branch || existing) this.current = (branch ?? existing)!.id;
			}
			return { id: this.current };
		}
		if (reason === "reload") return { id: this.current };
		const parentSessionId = reason === "fork" ? this.current : undefined;
		if (reason === "resume") {
			const sessions = (await this.client.request({ type: "list" })) as RelaySession[];
			const existing = sessions.find(
				(session) =>
					!session.ephemeral &&
					session.natives.some(
						(native) =>
							native.selection.backend === "pi" &&
							native.nativeId === manager.getSessionId() &&
							native.workspace === manager.getCwd(),
					),
			);
			const branchId = nativeProductSession(manager);
			const branch = sessions.find((session) => session.id === branchId && session.workspace === manager.getCwd());
			if (branch || existing) {
				this.current = (branch ?? existing)!.id;
				return { id: this.current };
			}
		}
		this.current = randomUUID();
		return { id: this.current, ...(parentSessionId ? { parentSessionId, purpose: "branch" } : {}) };
	}
	async register(
		manager: NativeManager,
		target: { id: string; parentSessionId?: string; purpose?: "branch" },
		selection: RuntimeSelection,
		ephemeral: boolean,
	): Promise<void> {
		const session = (await this.client.request({
			type: "create",
			sessionId: target.id,
			workspace: manager.getCwd(),
			selection,
			name: manager.getSessionName(),
			...target,
			ephemeral,
		})) as RelaySession;
		if (ephemeral) this.ephemeralIds.add(target.id);
		if (!session.turns.length && !session.events.some((event) => event.data.type === "import")) {
			const history = nativeHistory(manager);
			if (!ephemeral) {
				for (const entry of manager.getBranch()) {
					if (
						entry.type === "custom_message" &&
						(entry.customType === "relay-handoff" || entry.customType === "relay-native-display") &&
						entry.details &&
						typeof entry.details === "object"
					) {
						const details = entry.details as {
							sessionId?: string;
							handoff?: Handoff;
							history?: Extract<LedgerData, { type: "import" }>;
						};
						const references = details.handoff?.artifacts ?? details.history?.artifacts ?? [];
						if (details.sessionId && references.length) {
							const source = (await this.client.request({
								type: "get",
								sessionId: details.sessionId,
							})) as RelaySession;
							for (const artifact of references) {
								const captured = source.events.some(
									(event) =>
										event.data.type === "attachment" &&
										event.data.attachment.id === artifact.id &&
										event.data.attachment.uri === artifact.uri,
								);
								if (!captured) continue; // External references remain descriptive, with their original location.
								const copied = (await this.client.request({
									type: "copy_attachment",
									sessionId: target.id,
									sourceSessionId: details.sessionId,
									attachmentId: artifact.id,
								})) as AttachmentReference;
								history.artifacts = history.artifacts?.map((reference) =>
									reference.id === artifact.id && reference.uri === artifact.uri ? copied : reference,
								);
							}
						}
					}
					if (entry.type === "message" && entry.message.role === "user" && Array.isArray(entry.message.content)) {
						const message = history.messages.find((message) => message.id === entry.id);
						if (!message) continue;
						for (const block of entry.message.content) {
							if (block.type !== "image") continue;
							if (!imageMediaType(block.mimeType)) throw new Error("Unsupported branch image type");
							const attachment = (await this.client.request({
								type: "attach",
								sessionId: target.id,
								mediaType: block.mimeType,
								data: block.data,
								description: "Selected pi branch image",
							})) as AttachmentReference;
							message.attachments ??= [];
							message.attachments.push(attachment);
						}
					}
					if (
						entry.type === "custom_message" &&
						entry.customType === "relay-native-display" &&
						entry.details &&
						typeof entry.details === "object"
					) {
						const details = entry.details as {
							sessionId?: string;
							history?: Extract<LedgerData, { type: "import" }>;
						};
						for (const source of details.history?.messages ?? []) {
							const message = history.messages.find((message) => message.id === source.id);
							if (!message || !source.attachments?.length) continue;
							if (!details.sessionId) throw new Error("Foreign image history lacks a Relay session reference");
							message.attachments = [];
							for (const attachment of source.attachments)
								message.attachments.push(
									(await this.client.request({
										type: "copy_attachment",
										sessionId: target.id,
										sourceSessionId: details.sessionId,
										attachmentId: attachment.id,
									})) as AttachmentReference,
								);
						}
					}
				}
			}
			await this.client.request({ type: "import", sessionId: target.id, data: history });
		}
	}
	async navigate(manager: NativeManager): Promise<string> {
		const parent = (await this.client.request({ type: "get", sessionId: this.current })) as RelaySession;
		if (parent.turns.some((turn) => turn.status === "running" || turn.status === "unknown"))
			throw new Error("Settle and reconcile Relay execution before navigating branches");
		const target = { id: randomUUID(), parentSessionId: this.current, purpose: "branch" as const };
		await this.register(manager, target, parent.selection, parent.ephemeral === true);
		this.current = target.id;
		return this.current;
	}
}

function nativeProductSession(manager: NativeManager): string | undefined {
	for (const entry of [...manager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== "relay-product-session") continue;
		if (
			entry.data &&
			typeof entry.data === "object" &&
			"sessionId" in entry.data &&
			typeof entry.data.sessionId === "string"
		)
			return entry.data.sessionId;
	}
	return undefined;
}

export function nativeHistory(
	manager: Pick<SessionManager, "getBranch" | "getSessionId" | "getLeafId">,
): Extract<LedgerData, { type: "import" }> {
	const messages: Extract<LedgerData, { type: "import" }>["messages"] = [];
	const outcomes: Handoff["completedOutcomes"] = [];
	const artifacts: ArtifactReference[] = [];
	for (const entry of manager.getBranch()) {
		if (entry.type === "custom_message" && entry.customType === "relay-native-display") {
			const details =
				entry.details && typeof entry.details === "object"
					? (entry.details as { history?: Extract<LedgerData, { type: "import" }> })
					: undefined;
			if (details?.history) {
				messages.push(...details.history.messages.map((message) => ({ ...message })));
				outcomes.push(...details.history.outcomes);
				artifacts.push(...(details.history.artifacts ?? []));
			}
		}
		if (entry.type === "custom_message" && entry.customType === "relay-handoff") {
			const details =
				entry.details && typeof entry.details === "object" ? (entry.details as { handoff?: Handoff }) : undefined;
			if (details?.handoff?.version === 1) {
				messages.push(
					...details.handoff.conversation.map((message) => ({
						id: message.eventId,
						role: message.role,
						text: message.text,
					})),
				);
				outcomes.push(...details.handoff.completedOutcomes);
				artifacts.push(...details.handoff.artifacts);
			}
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user" || message.role === "assistant")
			messages.push({
				id: entry.id,
				role: message.role,
				text:
					typeof message.content === "string"
						? message.content
						: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
			});
		if (message.role === "toolResult")
			outcomes.push({
				eventId: entry.id,
				tool: message.toolName,
				outcome: JSON.stringify(message.content),
				effect: message.isError ? "unknown" : "completed",
			});
	}
	return {
		type: "import",
		// Foreign display messages are excluded from pi's model context, so their public evidence
		// must be handed off even when this branch uses the same native pi journal.
		source: `${manager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === "relay-native-display") ? "relay-pi-branch" : "pi"}:${manager.getSessionId()}:${manager.getLeafId() ?? "empty"}`,
		messages: [...new Map(messages.map((message) => [message.id, message])).values()],
		outcomes: [...new Map(outcomes.map((outcome) => [outcome.eventId, outcome])).values()],
		...(artifacts.length
			? {
					artifacts: [...new Map(artifacts.map((artifact) => [`${artifact.id}:${artifact.uri}`, artifact])).values()],
				}
			: {}),
	};
}
