import type { WorkerReport } from "../contracts.ts";

/** Native structured output is still untrusted evidence, never new authority. */
export const workerReportSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		summary: { type: "string" },
		findings: { type: "array", items: { type: "string" } },
		evidence: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: { id: { type: "string" }, uri: { type: "string" }, description: { type: "string" } },
				required: ["id", "uri", "description"],
			},
		},
		actions: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					description: { type: "string" },
					effect: { type: "string", enum: ["none", "completed", "unknown"] },
				},
				required: ["description", "effect"],
			},
		},
		environmentState: { type: "string" },
		blockers: { type: "array", items: { type: "string" } },
	},
	required: ["summary", "findings", "evidence", "actions", "environmentState", "blockers"],
};

export function workerReport(value: unknown): WorkerReport {
	if (!value || typeof value !== "object") throw new Error("Invalid native worker report");
	const report = value as WorkerReport;
	if (
		typeof report.summary !== "string" ||
		typeof report.environmentState !== "string" ||
		!Array.isArray(report.findings) ||
		report.findings.some((item) => typeof item !== "string") ||
		!Array.isArray(report.blockers) ||
		report.blockers.some((item) => typeof item !== "string") ||
		!Array.isArray(report.evidence) ||
		!Array.isArray(report.actions)
	)
		throw new Error("Invalid native worker report");
	for (const evidence of report.evidence)
		if (
			!evidence ||
			typeof evidence.id !== "string" ||
			typeof evidence.uri !== "string" ||
			typeof evidence.description !== "string"
		)
			throw new Error("Invalid worker evidence");
	for (const action of report.actions)
		if (!action || typeof action.description !== "string" || !["none", "completed", "unknown"].includes(action.effect))
			throw new Error("Invalid worker action");
	return {
		summary: report.summary,
		findings: report.findings,
		evidence: report.evidence,
		actions: report.actions,
		environmentState: report.environmentState,
		blockers: report.blockers,
	};
}
