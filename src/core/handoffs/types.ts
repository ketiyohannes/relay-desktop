import type { ArtifactReference } from "../sessions/types.ts";

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
