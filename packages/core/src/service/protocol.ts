import type {
	ArtifactReference,
	AttachmentReference,
	Backend,
	DelegationRequest,
	ExecutionStatus,
	LedgerData,
	McpServer,
	PermissionMode,
	ProductNote,
	RuntimeEvent,
	RuntimeSelection,
} from "../contracts.ts";

export type RelayCommand =
	| { type: "list" }
	| { type: "get"; sessionId: string }
	| { type: "copy_attachment"; sessionId: string; sourceSessionId: string; attachmentId: string }
	| {
			type: "attach";
			sessionId: string;
			mediaType: AttachmentReference["mediaType"];
			data: string;
			description: string;
	  }
	| {
			type: "create";
			sessionId: string;
			workspace: string;
			selection: RuntimeSelection;
			name?: string;
			parentSessionId?: string;
			ephemeral?: boolean;
			purpose?: "review" | "branch";
	  }
	| { type: "forget_ephemeral"; sessionId: string }
	| { type: "note"; sessionId: string; note: ProductNote }
	| { type: "select"; sessionId: string; selection: RuntimeSelection }
	| { type: "workspace"; sessionId: string; workspace: string }
	| {
			type: "submit";
			sessionId: string;
			turnId: string;
			text: string;
			permissionMode: PermissionMode;
			attachmentIds?: string[];
	  }
	| { type: "cancel"; sessionId: string }
	| { type: "wait"; sessionId: string }
	| { type: "approval"; sessionId: string; approvalId: string; allowed: boolean }
	| { type: "reconcile"; sessionId: string; turnId: string; description: string }
	| { type: "reset"; sessionId: string; description: string }
	| { type: "edit"; sessionId: string; operationId: string; path: string; expected: string; content: string }
	| {
			type: "host_start";
			sessionId: string;
			turnId: string;
			nativeId: string;
			nativeFile?: string;
			text: string;
			selection: RuntimeSelection;
			permissionMode: PermissionMode;
			attachmentIds?: string[];
	  }
	| { type: "host_event"; turnId: string; event: RuntimeEvent }
	| { type: "host_finish"; turnId: string; status: Exclude<ExecutionStatus, "running"> }
	| { type: "host_delegate"; turnId: string; request: DelegationRequest }
	| { type: "capabilities"; selection: RuntimeSelection }
	| { type: "import"; sessionId: string; data: Extract<LedgerData, { type: "import" }> };

export interface Request {
	version: 1;
	id: string;
	token: string;
	command: RelayCommand;
}
export interface Response {
	version: 1;
	id: string;
	result?: unknown;
	error?: string;
}

export function validateSelection(value: unknown): RuntimeSelection {
	const selection = object(value);
	const profile = string(selection.profile);
	const model = string(selection.model);
	const options = selection.options === undefined ? {} : object(selection.options);
	// Reconstruct public configuration. Unknown fields (including API keys) never enter history.
	if (selection.backend === "pi") {
		const provider = string(options.provider);
		if (!provider.trim()) throw new Error("Pi requires a provider");
		const thinking = options.thinking;
		if (
			thinking !== undefined &&
			!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(string(thinking))
		)
			throw new Error("Invalid pi thinking level");
		return {
			backend: "pi",
			profile,
			model,
			options: {
				provider,
				...(thinking === undefined
					? {}
					: { thinking: thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }),
			},
		};
	}
	const mcp = options.mcp === undefined ? undefined : validateMcp(options.mcp);
	if (selection.backend === "codex") {
		const effort = options.effort;
		if (effort !== undefined && !["low", "medium", "high", "xhigh"].includes(string(effort)))
			throw new Error("Invalid Codex effort");
		return {
			backend: "codex",
			profile,
			model,
			options: {
				...(mcp ? { mcp } : {}),
				...(effort === undefined ? {} : { effort: effort as "low" | "medium" | "high" | "xhigh" }),
			},
		};
	}
	if (selection.backend === "claude") {
		if (options.projectInstructions !== undefined && typeof options.projectInstructions !== "boolean")
			throw new Error("Invalid project instructions option");
		if (options.maxTurns !== undefined && (!Number.isSafeInteger(options.maxTurns) || Number(options.maxTurns) < 1))
			throw new Error("Invalid maximum turns");
		return {
			backend: "claude",
			profile,
			model,
			options: {
				...(mcp ? { mcp } : {}),
				...(options.projectInstructions === undefined
					? {}
					: { projectInstructions: options.projectInstructions as boolean }),
				...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns as number }),
			},
		};
	}
	throw new Error("Invalid runtime selection");
}

export function validateImport(value: unknown): Extract<LedgerData, { type: "import" }> {
	const data = object(value);
	if (data.type !== "import" || !Array.isArray(data.messages) || !Array.isArray(data.outcomes))
		throw new Error("Invalid public history import");
	if (data.artifacts !== undefined && !Array.isArray(data.artifacts)) throw new Error("Invalid imported artifacts");
	return {
		type: "import",
		source: string(data.source),
		...(data.artifacts === undefined ? {} : { artifacts: data.artifacts.map(validateArtifact) }),
		messages: data.messages.map((value) => {
			const message = object(value);
			if (message.role !== "user" && message.role !== "assistant") throw new Error("Invalid public message role");
			if (message.attachments !== undefined && !Array.isArray(message.attachments))
				throw new Error("Invalid imported attachments");
			return {
				id: string(message.id),
				role: message.role,
				text: string(message.text),
				...(message.attachments === undefined
					? {}
					: {
							attachments: message.attachments.map((value: unknown) => {
								const attachment = object(value);
								if (
									!Number.isSafeInteger(attachment.bytes) ||
									Number(attachment.bytes) < 1 ||
									Number(attachment.bytes) > 10 * 1024 * 1024
								)
									throw new Error("Invalid imported attachment size");
								const mediaType = string(attachment.mediaType);
								if (!["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"].includes(mediaType))
									throw new Error("Invalid imported attachment type");
								return {
									id: string(attachment.id),
									uri: string(attachment.uri),
									description: string(attachment.description),
									sha256: string(attachment.sha256),
									bytes: Number(attachment.bytes),
									mediaType: mediaType as AttachmentReference["mediaType"],
								};
							}),
						}),
			};
		}),
		outcomes: data.outcomes.map((value) => {
			const outcome = object(value);
			if (outcome.effect !== "completed" && outcome.effect !== "unknown")
				throw new Error("Invalid completed outcome");
			return {
				eventId: string(outcome.eventId),
				tool: string(outcome.tool),
				outcome: string(outcome.outcome),
				effect: outcome.effect,
			};
		}),
	};
}

/** Frontend-hosted runtimes may report public observations, never service-owned state. */
export function validateHostedEvent(value: unknown): RuntimeEvent {
	const event = object(value);
	switch (event.type) {
		case "accepted":
			return {
				type: "accepted",
				...(event.nativeTurnId === undefined ? {} : { nativeTurnId: string(event.nativeTurnId) }),
			};
		case "text":
			if (typeof event.complete !== "boolean") throw new Error("Invalid text completion flag");
			return { type: "text", id: string(event.id), text: string(event.text), complete: event.complete };
		case "tool_start":
			return { type: "tool_start", id: string(event.id), name: string(event.name), input: event.input ?? null };
		case "tool_progress":
			return { type: "tool_progress", id: string(event.id), text: string(event.text) };
		case "tool_end":
			if (typeof event.failed !== "boolean") throw new Error("Invalid tool failure flag");
			return {
				type: "tool_end",
				id: string(event.id),
				name: string(event.name),
				output: event.output ?? null,
				failed: event.failed,
			};
		case "approval":
			return { type: "approval", id: string(event.id), tool: string(event.tool), input: event.input ?? null };
		case "artifact":
			return { type: "artifact", artifact: validateArtifact(event.artifact) };
		case "usage": {
			const usage: Record<string, number> = {};
			for (const [key, amount] of Object.entries(object(event.usage))) {
				if (
					!/^[a-zA-Z0-9_]+$/.test(key) ||
					["__proto__", "constructor", "prototype"].includes(key) ||
					typeof amount !== "number" ||
					!Number.isFinite(amount) ||
					amount < 0
				)
					throw new Error("Invalid usage observation");
				usage[key] = amount;
			}
			return { type: "usage", usage };
		}
		case "compaction":
			return { type: "compaction", description: string(event.description) };
		default:
			throw new Error("Unsupported hosted event");
	}
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration object");
	return value as Record<string, unknown>;
}
function string(value: unknown): string {
	if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid configuration string");
	return value;
}
function validateArtifact(value: unknown): ArtifactReference {
	const artifact = object(value);
	if (artifact.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(string(artifact.sha256)))
		throw new Error("Invalid artifact digest");
	return {
		id: string(artifact.id),
		uri: string(artifact.uri),
		description: string(artifact.description),
		...(artifact.sha256 === undefined ? {} : { sha256: string(artifact.sha256) }),
	};
}
function validateMcp(value: unknown): Record<string, McpServer> {
	const servers: Record<string, McpServer> = {};
	for (const [name, config] of Object.entries(object(value))) {
		if (!/^[a-zA-Z0-9_-]+$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name))
			throw new Error("Invalid MCP server name");
		const server = object(config);
		const command = string(server.command);
		if (!command || !Array.isArray(server.args)) throw new Error("Invalid MCP command");
		const args = server.args.map(string);
		if (server.envKeys !== undefined && !Array.isArray(server.envKeys))
			throw new Error("Invalid MCP environment keys");
		const envKeys = (server.envKeys as unknown[] | undefined)?.map(string);
		if (envKeys?.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new Error("Invalid MCP environment key");
		servers[name] = { command, args, ...(envKeys ? { envKeys } : {}) };
	}
	return servers;
}

export function selection(backend: Backend, model: string, profile = "", provider?: string): RuntimeSelection {
	if (backend === "pi") {
		if (!provider) throw new Error("Pi requires --provider");
		return { backend, model, profile, options: { provider } };
	}
	return { backend, model, profile };
}
