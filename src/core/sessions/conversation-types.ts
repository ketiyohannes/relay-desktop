import type { LedgerEvent } from "./types.ts";

export class AccountExhaustedError extends Error {}
export class UncertainExecutionError extends Error {}
export interface EngineCallbacks {
	readOnly?: boolean;
	review?: { parentSessionId: string };
	text(id: string, text: string, complete: boolean): Promise<void>;
	tool(id: string, name: string, input: unknown, result?: unknown, failed?: boolean): Promise<void>;
	toolProgress?(id: string, progress: string, output?: unknown): Promise<void>;
	checkpoint(label: string, toolId?: string): Promise<void>;
	session(id: string): Promise<void>;
	permission(
		tool: string,
		input: unknown,
		scope?: { sessionId: string; turnId: string },
		signal?: AbortSignal,
	): Promise<boolean>;
	event?(event: LedgerEvent): Promise<void>;
}
