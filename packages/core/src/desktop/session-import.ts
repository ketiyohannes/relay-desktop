import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
	getSessionInfo,
	getSessionMessages,
	type SessionStore,
	type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { expandTildePath } from "./config.ts";
import type {
	DesktopAction,
	DesktopSession,
	ExternalSession,
	ExternalSessionPreview,
	ExternalSessions,
} from "./types.ts";

const MAX_BYTES = 128 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");

export function sessionMessageLabel(text: string): string | undefined {
	const value = text.trimStart();
	if (/^#\s*AGENTS\.md instructions\b|^<user_instructions>|^<INSTRUCTIONS>/i.test(value))
		return "Project instructions";
	if (/^<environment_context>/i.test(value)) return "Environment";
	if (/^<permissions instructions>|^<system-reminder>|^<skills_instructions>/i.test(value)) return "System context";
	if (/^<turn_aborted>|^\[Request interrupted by user/i.test(value)) return "Interrupted turn";
	if (
		/^This session is being continued from a previous conversation|^Imported context summary:|^Another language model started to solve this problem and produced a summary/i.test(
			value,
		)
	)
		return "Context summary";
	if (/^<local-command-|^<command-name>/i.test(value)) return "Local command";
	return undefined;
}

/** Display projection only: never rewrites source messages or the shared ledger. */
export function sessionChatText(text: string, channel?: string): string {
	if (channel === "analysis" || channel === "justify" || channel === "confidence") return "";
	if (sessionMessageLabel(text) === "Context summary") return "";
	let value = text.trim();
	if (/^#\s*AGENTS\.md instructions\b/i.test(value)) {
		const end = value.indexOf("</INSTRUCTIONS>");
		if (end < 0) return "";
		value = value.slice(end + "</INSTRUCTIONS>".length).trim();
	}
	const leading =
		/^<(user_instructions|INSTRUCTIONS|environment_context|system-reminder|skills_instructions|permissions instructions|turn_aborted)>[\s\S]*?<\/\1>\s*/i;
	const trailing =
		/\s*<(user_instructions|INSTRUCTIONS|environment_context|system-reminder|skills_instructions|permissions instructions|turn_aborted)>(?:(?!<\/\1>)[\s\S])*<\/\1>$/i;
	let previous: string;
	do {
		previous = value;
		value = value.replace(leading, "").replace(trailing, "").trim();
	} while (value !== previous);
	if (sessionMessageLabel(value)) return "";
	if (value.startsWith("<send_user_message_question_reply>")) {
		try {
			const replies: unknown = JSON.parse(
				value.replace(/^<send_user_message_question_reply>\s*|\s*<\/send_user_message_question_reply>$/g, ""),
			);
			if (Array.isArray(replies))
				return replies
					.map((reply: unknown) => string(object(reply).answer))
					.filter(Boolean)
					.join("\n\n");
		} catch {
			/* Malformed replies stay visible rather than losing user text. */
		}
	}
	return value;
}

function internalCodexSession(meta: Record<string, unknown>): boolean {
	return !!object(meta.source).subagent || meta.thread_source === "guardian_review";
}

function promptTitle(records: SessionStoreEntry[], provider: "codex" | "claude"): string {
	for (const record of records) {
		if (record.isMeta || record.isSidechain) continue;
		const body = provider === "codex" ? object(record.payload) : object(record.message);
		const text =
			body.type === "user_message" ? string(body.message) : body.role === "user" ? contentText(body.content) : "";
		const visible = sessionChatText(text);
		if (visible) return visible.replace(/\s+/g, " ").trim().slice(0, 120);
	}
	return "";
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return value === undefined ? "" : JSON.stringify(value);
	return value
		.map((block: unknown) => {
			const entry = object(block);
			if (["text", "input_text", "output_text"].includes(string(entry.type))) return string(entry.text);
			if (["image", "input_image", "document"].includes(string(entry.type)))
				return "[Attachment not transferred; attach it again to use it.]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

async function readTranscript(path: string, part?: "head" | "tail"): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await file.stat();
		if (!info.isFile()) throw new Error("Choose a regular JSONL session file");
		if (!part && info.size > MAX_BYTES) throw new Error("Session exceeds the 128 MiB import limit");
		const size = Math.min(info.size, part ? 128 * 1024 : MAX_BYTES);
		const start = part === "tail" ? info.size - size : 0;
		const buffer = Buffer.alloc(size);
		let offset = 0;
		while (offset < size) {
			const { bytesRead } = await file.read(buffer, offset, size - offset, start + offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		const text = buffer.subarray(0, offset).toString("utf8");
		if (part === "tail" && start) return text.slice(text.indexOf("\n") + 1);
		return part === "head" && info.size > size ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
	} finally {
		await file.close();
	}
}

function parseRecords(text: string, warnings: string[]): SessionStoreEntry[] {
	const lines = text.split("\n");
	const records: SessionStoreEntry[] = [];
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		try {
			const value = object(JSON.parse(line));
			if (typeof value.type === "string") records.push(value as SessionStoreEntry);
		} catch {
			if (index === lines.length - 1 && !text.endsWith("\n"))
				warnings.push(
					"An unfinished last record was skipped. Stop the source session before importing its latest state.",
				);
			else throw new Error(`Invalid session JSON on line ${index + 1}`);
		}
	}
	return records;
}

/** Local, read-only discovery. Never reads auth files, executes tools, or starts an agent. */
export class DesktopSessionImporter {
	private readonly sources = new Map<string, ExternalSession>();
	private readonly metadata = new Map<string, { updated: number; size: number; source: ExternalSession }>();
	/** Recover display channels for old imports without replacing their saved actions. */
	async presentation(session: DesktopSession): Promise<{ internal: boolean; channels: Map<string, string> }> {
		const channels = new Map<string, string>();
		if (session.importedFrom?.provider !== "codex") return { internal: false, channels };
		const metadata = parseRecords(await readTranscript(session.importedFrom.path, "head"), []);
		const meta = object(metadata.find((entry) => entry.type === "session_meta")?.payload);
		if (meta.id !== session.importedFrom.sessionId) throw new Error("Source session changed");
		if (internalCodexSession(meta)) return { internal: true, channels };
		if (
			session.actions
				.filter((action) => action.kind === "assistant")
				.every((action) => action.displayText !== undefined)
		)
			return { internal: false, channels };
		const records = parseRecords(await readTranscript(session.importedFrom.path), []);
		const messages = new Map<string, string[]>();
		for (const record of records) {
			const body = object(record.payload);
			if (record.type !== "response_item" || body.type !== "message") continue;
			const key = `${body.role}:${contentText(body.content)}`;
			const entries = messages.get(key) || [];
			entries.push(string(body.channel));
			messages.set(key, entries);
		}
		for (const action of session.actions) {
			if (action.kind === "switch" && action.text.startsWith("Imported from ")) break;
			const channel = messages.get(`${action.kind}:${action.text}`)?.shift();
			if (channel) channels.set(action.id, channel);
		}
		return { internal: false, channels };
	}
	async list(provider: "codex" | "claude", input?: string): Promise<ExternalSessions> {
		if (!["codex", "claude"].includes(provider)) throw new Error("Unknown session provider");
		const path = await realpath(
			expandTildePath(
				input ||
					(provider === "codex"
						? process.env.CODEX_HOME || join(homedir(), ".codex")
						: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")),
			),
		);
		const info = await lstat(path);
		const titles = new Map<string, string>();
		if (provider === "codex") {
			let directory = info.isDirectory() ? path : dirname(path);
			for (let depth = 0; depth < 8; depth++) {
				try {
					const index = await readTranscript(join(directory, "session_index.jsonl"));
					for (const line of index.split("\n")) {
						try {
							const entry = object(JSON.parse(line));
							if (string(entry.id) && string(entry.thread_name).trim())
								titles.set(
									string(entry.id),
									string(entry.thread_name).replace(/\s+/g, " ").trim().slice(0, 120),
								);
						} catch {
							/* A concurrently appended title may be incomplete. */
						}
					}
					break;
				} catch {
					/* Native titles are optional; transcript prompts remain available. */
				}
				const parent = dirname(directory);
				if (parent === directory) break;
				directory = parent;
			}
		}
		const files: { path: string; updated: number; size: number }[] = [];
		const warnings: string[] = [];
		const queue: { path: string; depth: number }[] = info.isDirectory() ? [{ path, depth: 0 }] : [];
		if (info.isFile() && path.endsWith(".jsonl")) files.push({ path, updated: info.mtimeMs, size: info.size });
		let visited = 0;
		while (queue.length && visited < 20000 && files.length < 2000) {
			const directory = queue.shift()!;
			try {
				for await (const entry of await opendir(directory.path)) {
					if (++visited > 20000 || files.length >= 2000) break;
					if (entry.isSymbolicLink()) continue;
					const child = join(directory.path, entry.name);
					if (
						entry.isDirectory() &&
						directory.depth < 6 &&
						!["subagents", "node_modules", ".git"].includes(entry.name)
					)
						queue.push({ path: child, depth: directory.depth + 1 });
					else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
						const info = await lstat(child);
						files.push({ path: child, updated: info.mtimeMs, size: info.size });
					}
				}
			} catch {
				warnings.push(`Could not read directory: ${directory.path}`);
			}
		}
		if (queue.length || visited >= 20000 || files.length >= 2000)
			warnings.push(
				"Discovery reached its limit (2,000 files / 20,000 entries). Choose a narrower sessions folder to find more.",
			);
		const items: ExternalSession[] = [];
		let skipped = 0;
		for (const file of files.sort((a, b) => b.updated - a.updated)) {
			try {
				const key = `${provider}:${file.path}`;
				const cached = this.metadata.get(key);
				if (cached?.updated === file.updated && cached.size === file.size) {
					const source = { ...cached.source, name: titles.get(cached.source.sessionId) || cached.source.name };
					this.sources.set(source.id, source);
					items.push(source);
					continue;
				}
				const records = parseRecords(await readTranscript(file.path, "head"), []);
				if (provider === "claude" && file.size > 128 * 1024)
					records.push(...parseRecords(await readTranscript(file.path, "tail"), []));
				const meta =
					provider === "codex"
						? object(records.find((entry) => entry.type === "session_meta")?.payload)
						: records.find((entry) => entry.sessionId && !entry.isSidechain) || {};
				const sessionId = string(provider === "codex" ? meta.id : meta.sessionId);
				if (!sessionId) continue;
				if (provider === "codex" && internalCodexSession(meta)) continue;
				const info =
					provider === "claude"
						? await getSessionInfo(sessionId, {
								sessionStore: {
									load: async () => records,
									append: async () => {
										throw new Error("Import source is read only");
									},
								},
							})
						: undefined;
				const nativeTitle =
					titles.get(sessionId) ||
					info?.customTitle ||
					(info?.summary && !sessionMessageLabel(info.summary) ? info.summary : "");
				const source: ExternalSession = {
					id: createHash("sha256").update(`${provider}:${file.path}`).digest("hex"),
					provider,
					sessionId,
					name:
						nativeTitle.replace(/\s+/g, " ").trim().slice(0, 120) ||
						promptTitle(records, provider) ||
						`${provider === "codex" ? "Codex" : "Claude"} session · ${sessionId.slice(0, 8)}`,
					project: info?.cwd || string(meta.cwd),
					path: file.path,
					updated: file.updated,
				};
				this.sources.set(source.id, source);
				this.metadata.set(key, { ...file, source });
				if (this.metadata.size > 8000) this.metadata.delete(this.metadata.keys().next().value!);
				items.push(source);
			} catch {
				skipped++;
			}
		}
		if (skipped) warnings.push(`${skipped} unreadable or invalid session files skipped.`);
		return { path, items, warnings };
	}
	async preview(id: string): Promise<ExternalSessionPreview> {
		const source = this.sources.get(id);
		if (!source) throw new Error("Refresh the import list and select a session");
		const warnings = [
			"Imports conversation text and tool results. File snapshots, attachments, permissions, and provider settings are not transferred. Continuation uses Relay's shared history in a new provider conversation.",
		];
		const records = parseRecords(await readTranscript(source.path), warnings);
		const actions: DesktopAction[] = [];
		const tools = new Map<string, DesktopAction>();
		const append = (
			kind: DesktopAction["kind"],
			text: string,
			timestamp?: unknown,
			extra: Partial<DesktopAction> = {},
		) => {
			const action: DesktopAction = {
				id: randomUUID(),
				kind,
				text,
				provider: source.provider === "codex" ? "Codex" : "Claude",
				label: sessionMessageLabel(text),
				time: Date.parse(string(timestamp)) || source.updated,
				...extra,
			};
			if (["user", "assistant"].includes(kind) && action.displayText === undefined)
				action.displayText = sessionChatText(text, action.channel);
			actions.push(action);
			return action;
		};
		const call = (id: string, name: string, input: unknown, timestamp: unknown) => {
			const action = append("tool", name || "Tool", timestamp, {
				toolId: `import:${id}`,
				input: typeof input === "string" ? input : JSON.stringify(input ?? {}),
				status: "error",
				output: "No completed result recorded; inspect current files before continuing.",
			});
			tools.set(id, action);
		};
		const result = (id: string, output: unknown, timestamp: unknown, failed = false) => {
			let action = tools.get(id);
			if (!action) {
				call(id, "Imported tool result", {}, timestamp);
				action = tools.get(id)!;
			}
			action.output = contentText(output);
			action.status = failed ? "error" : "done";
			action.finished = Date.parse(string(timestamp)) || action.time;
		};
		let resolvedSource = { ...source };
		if (source.provider === "claude") {
			if (!records.some((entry) => entry.sessionId === source.sessionId))
				throw new Error("Source session changed; refresh the import list");
			const sessionStore: SessionStore = {
				load: async () => records,
				append: async () => {
					throw new Error("Import source is read only");
				},
			};
			const info = await getSessionInfo(source.sessionId, { sessionStore, dir: source.project || undefined });
			if (info)
				resolvedSource = {
					...source,
					name:
						info.customTitle || (info.summary && !sessionMessageLabel(info.summary) ? info.summary : source.name),
					project: info.cwd || source.project,
				};
			const messages = await getSessionMessages(source.sessionId, {
				sessionStore,
				dir: source.project || undefined,
				includeSystemMessages: true,
			});
			const timestamps = new Map(records.map((entry) => [entry.uuid, entry.timestamp]));
			const metadataIds = new Set(records.filter((entry) => entry.isMeta).map((entry) => entry.uuid));
			for (const message of messages) {
				const body = object(message.message);
				const timestamp = timestamps.get(message.uuid);
				if (!Array.isArray(body.content)) {
					const text = contentText(body.content);
					if (text)
						append(
							message.type === "system" ? "switch" : message.type,
							text,
							timestamp,
							metadataIds.has(message.uuid) ? { displayText: "", label: "System context" } : {},
						);
				}
				if (Array.isArray(body.content))
					for (const raw of body.content) {
						const block = object(raw);
						const text = contentText([block]);
						if (text)
							append(
								message.type === "system" ? "switch" : message.type,
								text,
								timestamp,
								metadataIds.has(message.uuid) ? { displayText: "", label: "System context" } : {},
							);
						if (block.type === "tool_use") call(string(block.id), string(block.name), block.input, timestamp);
						if (block.type === "tool_result")
							result(string(block.tool_use_id), block.content, timestamp, block.is_error === true);
					}
			}
		} else {
			const meta = object(records.find((entry) => entry.type === "session_meta")?.payload);
			if (meta.id !== source.sessionId) throw new Error("Source session changed; refresh the import list");
			if (internalCodexSession(meta)) throw new Error("Internal agent sessions are not chat conversations");
			const hasResponses = records.some(
				(entry) => entry.type === "response_item" && object(entry.payload).type === "message",
			);
			for (const entry of records) {
				const body = object(entry.payload);
				if (entry.type === "response_item") {
					if (body.type === "message" && ["user", "assistant"].includes(string(body.role))) {
						const text = contentText(body.content);
						if (text)
							append(body.role as "user" | "assistant", text, entry.timestamp, {
								channel: string(body.channel) || undefined,
							});
					} else if (["function_call", "custom_tool_call"].includes(string(body.type)))
						call(string(body.call_id), string(body.name), body.arguments ?? body.input, entry.timestamp);
					else if (["function_call_output", "custom_tool_call_output"].includes(string(body.type)))
						result(string(body.call_id), body.output, entry.timestamp);
				} else if (
					entry.type === "event_msg" &&
					!hasResponses &&
					["user_message", "agent_message"].includes(string(body.type))
				) {
					append(body.type === "user_message" ? "user" : "assistant", string(body.message), entry.timestamp);
				} else if (entry.type === "compacted" && typeof body.message === "string")
					append("assistant", `Imported context summary:\n${body.message}`, entry.timestamp);
				else if (entry.type === "event_msg" && body.type === "thread_rolled_back") {
					const count = Number(body.num_turns);
					if (!Number.isSafeInteger(count) || count < 0) throw new Error("Unsupported rollback record");
					const turns = Math.min(count, actions.length);
					for (let turn = 0; turn < turns; turn++) {
						const start = actions.findLastIndex((action) => action.kind === "user");
						if (start >= 0) actions.splice(start);
					}
					tools.clear();
					for (const action of actions) if (action.toolId) tools.set(action.toolId.slice(7), action);
				}
			}
		}
		if (!actions.length) throw new Error("No supported conversation messages in this session");
		if (!resolvedSource.project || !isAbsolute(resolvedSource.project))
			warnings.push("The original project is unavailable. Choose a project folder to continue this conversation.");
		return { source: resolvedSource, actions, warnings };
	}
}
