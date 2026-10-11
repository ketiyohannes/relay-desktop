import { type FSWatcher, watch } from "node:fs";
import { rm } from "node:fs/promises";

import type { AccountCatalogLoader } from "../accounts/catalog.ts";

import type { DesktopAccount } from "../accounts/types.ts";
import type { DesktopAction, DesktopSession, DesktopState } from "../desktop/types.ts";
import { PermissionGate } from "../permissions/gate.ts";
import { projectEvents } from "../sessions/desktop-projection.ts";
import { isChangePath } from "../timeline/change-filter.ts";
import { DesktopTimeline } from "../timeline/snapshots.ts";
import { AccountExhaustedError, type EngineCallbacks, UncertainExecutionError } from "./conversation-types.ts";
export type DesktopEngine = (
	session: DesktopSession,
	account: DesktopAccount,
	prompt: string,
	abort: AbortController,
	callbacks: EngineCallbacks,
) => Promise<void>;

interface ConversationHost {
	state(): DesktopState;
	append(session: DesktopSession, action: Omit<DesktopAction, "id" | "time">): DesktopAction;
	save(ids: readonly string[]): Promise<void>;
	execute: DesktopEngine;
	catalog: AccountCatalogLoader;
	journalEvents: boolean;
	permission(
		tool: string,
		input: unknown,
		scope?: { sessionId: string; turnId: string },
		signal?: AbortSignal,
	): Promise<boolean>;
	stream(session: DesktopSession, actions: DesktopAction[]): void;
	streamEvent(
		session: DesktopSession,
		event: Parameters<typeof projectEvents>[1][number],
		previousLength: number,
	): void;
	refreshChanges(project: string): Promise<void>;
	timelineUnavailable(project: string): void;
	publish(settled?: boolean): Promise<void>;
}

export class ConversationRunner {
	abort?: AbortController;
	switching = false;
	cancelled = false;
	private readonly host: ConversationHost;
	constructor(host: ConversationHost) {
		this.host = host;
	}
	async run(
		session: DesktopSession,
		text: string,
		abort: AbortController,
		review?: DesktopAction,
		reviewDirectory?: string,
	): Promise<void> {
		const timeline = new DesktopTimeline(session.project, session.id);
		let assistant: DesktopAction | undefined;
		let uncertain = false;
		let timelineEnabled = session.timelineEnabled ?? false;
		let respondingProvider: string | undefined;
		let watcher: FSWatcher | undefined;
		let observation: ReturnType<typeof setTimeout> | undefined;
		let observationWork: Promise<void> = Promise.resolve();
		const callbacks: EngineCallbacks = {
			...(review ? { review: { parentSessionId: session.id } } : {}),
			...(this.host.journalEvents && !review
				? ({
						event: async (event) => {
							const length = session.actions.length;
							projectEvents(session, [event]);
							session.relayLedgerSequence = event.sequence;
							this.host.streamEvent(session, event, length);
						},
					} satisfies Pick<EngineCallbacks, "event">)
				: {}),
			readOnly: !!review || session.permissionMode === "read-only",
			permission: async (tool, input, scope, signal) => {
				const readOnlyRoot = reviewDirectory || (session.permissionMode === "read-only" ? session.project : undefined);
				if (!readOnlyRoot) {
					// Native adapters already apply the selected mode; unresolved escalations must reach the user.
					if (scope) return this.host.permission(tool, input, scope, signal);
					if (session.permissionMode === "full-access") return !signal?.aborted;
					if (
						session.permissionMode === "auto-approve" &&
						[
							"read",
							"grep",
							"find",
							"ls",
							"write",
							"edit",
							"Read",
							"Grep",
							"Glob",
							"Write",
							"Edit",
							"NotebookEdit",
						].includes(tool)
					)
						return true;
					return this.host.permission(tool, input, scope, signal);
				}
				return new PermissionGate().check("read-only", readOnlyRoot, tool, input, async () => {});
			},
			session: async (id) => {
				if (review) return;
				session.claudeSessionId = id;
				await this.host.save([session.id]);
			},
			text: async (id, content, complete) => {
				if (this.host.journalEvents && !review) assistant = session.actions.find((action) => action.id === id);
				if (!content && !assistant) return;
				if (!assistant)
					assistant = this.host.append(session, {
						kind: review ? "review" : "assistant",
						provider: respondingProvider,
						text: "",
						status: "running",
						...(review ? { snapshot: review.snapshot, previous: review.previous } : {}),
					});
				if (this.host.journalEvents && !review) assistant.id = id;
				assistant.text = complete ? content : assistant.text + content;
				const changed = assistant;
				if (complete) {
					assistant.status = "done";
					assistant = undefined;
				}
				this.host.stream(session, [changed]);
			},
			tool: async (id, name, input, result, failed) => {
				let action = session.actions.find((a) => a.kind === "tool" && a.toolId === id);
				if (!action)
					action = this.host.append(session, {
						kind: "tool",
						provider: respondingProvider,
						text: name,
						toolId: id,
						input: JSON.stringify(input, null, 2),
						status: "running",
					});
				if (this.host.journalEvents && !review) action.id = id;
				if (result !== undefined) {
					action.output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
					action.text = `${name}\n${JSON.stringify(result, null, 2)}`;
					action.status = failed ? "error" : "done";
					action.finished = Date.now();
					delete action.progress;
				}
				this.host.stream(session, [action]);
			},
			toolProgress: async (id, progress, output) => {
				const action = session.actions.find(
					(entry) => entry.kind === "tool" && entry.toolId === id && entry.status === "running",
				);
				if (!action) return;
				action.progress = progress;
				if (output !== undefined) action.output = typeof output === "string" ? output : JSON.stringify(output, null, 2);
				this.host.stream(session, [action]);
			},
			checkpoint: async (label, toolId) => {
				if (!timelineEnabled || review) return;
				try {
					const snapshot = await timeline.checkpoint(label);
					if (snapshot.snapshot !== snapshot.previous) {
						this.host.append(session, { kind: "checkpoint", text: label, toolId, ...snapshot });
						await this.host.refreshChanges(session.project);
						await this.host.publish();
					}
				} catch {
					timelineEnabled = false;
					this.host.timelineUnavailable(session.project);
					await this.host.publish();
				}
			},
		};
		try {
			await callbacks.checkpoint("Session baseline");
			if (timelineEnabled && !review) {
				try {
					watcher = watch(session.project, { recursive: true }, (_event, file) => {
						if (!file || !isChangePath(file.toString())) return;
						if (observation) clearTimeout(observation);
						observation = setTimeout(() => {
							observation = undefined;
							observationWork = observationWork.then(() => callbacks.checkpoint("Live filesystem observation"));
							void observationWork.catch(() => {});
						}, 120);
					});
					watcher.on("error", () => watcher?.close());
				} catch {
					/* Tool-boundary capture remains available when recursive watching is unsupported. */
				}
			}
			const attempted = new Set<string>();
			let prompt = text;
			while (!this.cancelled && (!abort.signal.aborted || this.switching)) {
				if (this.switching && abort.signal.aborted) {
					this.switching = false;
					abort = new AbortController();
					this.abort = abort;
				}
				const account = this.host.state().accounts.find((a) => a.id === session.accountId);
				if (!account) throw new Error("Account unavailable");
				attempted.add(account.id);
				respondingProvider =
					account.engine === "claude" ? "Claude" : account.provider === "openai-codex" ? "Codex" : account.provider;
				try {
					await this.host.execute(
						reviewDirectory ? { ...session, project: reviewDirectory, claudeSessionId: undefined } : session,
						{ ...account, model: session.models?.[account.id] ?? account.model },
						prompt,
						abort,
						callbacks,
					);
					if (this.switching) throw new Error("Account switch requested");
					if (!review) session.lastEngine = account.engine;
					break;
				} catch (error) {
					if (!review) session.lastEngine = account.engine;
					if (error instanceof UncertainExecutionError) {
						this.switching = false;
						throw error;
					}
					if (this.switching) {
						this.switching = false;
						if (assistant) {
							assistant.status = "error";
							assistant = undefined;
						}
						for (const action of session.actions) {
							if (action.kind === "tool" && action.status === "running") {
								action.status = "error";
								action.text += "\nInterrupted by account switch. Inspect working files before continuing.";
							}
						}
						await callbacks.checkpoint("Manual switch settled");
						if (this.cancelled) break;
						abort = new AbortController();
						this.abort = abort;
						prompt = review
							? text
							: "Continue the interrupted request from Relay history. Inspect current files and completed tool results first. Do not replay completed commands or edits.";
						await this.host.publish();
						continue;
					}
					if (!(error instanceof AccountExhaustedError) || !session.autoSwitch || abort.signal.aborted) throw error;
					const index = this.host.state().accounts.findIndex((a) => a.id === account.id);
					const candidates = [
						...this.host.state().accounts.slice(index + 1),
						...this.host.state().accounts.slice(0, index),
					].filter((a) => !attempted.has(a.id));
					let next: DesktopAccount | undefined;
					for (const candidate of candidates) {
						attempted.add(candidate.id);
						try {
							const catalog = await this.host.catalog(candidate);
							const model = session.models?.[candidate.id] ?? candidate.model;
							if (
								catalog.connected === false ||
								!catalog.models.some(
									(entry) =>
										entry.authenticated &&
										(entry.id === model || (candidate.engine === "claude" && !model && entry.id === "default")),
								)
							)
								throw new Error("Selected model or authentication unavailable");
							next = candidate;
						} catch {
							this.host.append(session, {
								kind: "switch",
								text: `Skipped ${candidate.name}: connection or selected model unavailable`,
							});
						}
						if (next || this.cancelled || this.switching || abort.signal.aborted) break;
					}
					if (this.cancelled) break;
					if (this.switching) continue;
					if (!session.autoSwitch) throw error;
					if (!next) throw new Error("All configured accounts are exhausted or unavailable");
					if (assistant) {
						assistant.status = "error";
						assistant = undefined;
					}
					for (const action of session.actions) {
						if (action.kind === "tool" && action.status === "running") {
							action.status = "error";
							action.text += "\nInterrupted by quota exhaustion. Inspect working files before continuing.";
						}
					}
					await callbacks.checkpoint("Quota switch settled");
					if (this.cancelled) break;
					if (this.switching) continue;
					if (!session.autoSwitch) throw error;
					this.host.append(session, { kind: "switch", text: `${account.name} exhausted → ${next.name}` });
					session.accountId = next.id;
					prompt = review
						? text
						: "Continue the interrupted request from the Relay history. Inspect current files and completed tool results first. Do not replay completed commands or edits.";
					await this.host.publish();
				}
			}
		} catch (error) {
			uncertain = error instanceof UncertainExecutionError;
			this.host.append(session, { kind: "error", text: error instanceof Error ? error.message : String(error) });
			if (uncertain && reviewDirectory)
				this.host.append(session, {
					kind: "error",
					text: `Review workspace retained for reconciliation: ${reviewDirectory}`,
				});
		} finally {
			watcher?.close();
			if (observation) clearTimeout(observation);
			await observationWork.catch(() => {});
			if (assistant) assistant.status = "error";
			for (const action of session.actions) {
				if (action.kind === "tool" && action.status === "running") {
					action.status = "error";
					action.text += "\nInterrupted; the tool outcome is unknown. Inspect working files before continuing.";
				}
			}
			try {
				await callbacks.checkpoint("Run settled");
				if (reviewDirectory && !uncertain) await rm(reviewDirectory, { recursive: true, force: true });
			} finally {
				await this.host.publish(true);
			}
		}
	}
}
