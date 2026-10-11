import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publicHistory } from "../../src/core/desktop/engines.ts";
import { DesktopSessionImporter } from "../../src/core/desktop/session-import.ts";

for (const [label, metadata, output, orphan, expected] of [
	["structured success", { exit_code: 0 }, "successful", false, "done"],
	["structured failure with partial effects", { exit_code: 1 }, "wrote file before failure", false, "error"],
	["unverified failure text", undefined, "Process exited with code 1\nOutput:\ncommand failed", false, "unknown"],
	["unverified success text", undefined, "Process exited with code 0\nOutput:\nokay", false, "unknown"],
	["orphan structured success", { exit_code: 0 }, "orphan", true, "unknown"],
] as const) {
	test(`R05: Codex ${label} preserves outcome certainty in public history`, async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "relay-codex-outcome-"));
		try {
			const path = join(root, "session.jsonl");
			const records = [
				{ type: "session_meta", payload: { id: "session", cwd: root } },
				{
					type: "response_item",
					payload: { type: "message", role: "user", content: [{ type: "input_text", text: "work" }] },
				},
				...(!orphan
					? [
							{
								type: "response_item",
								payload: { type: "function_call", call_id: "call", name: "exec_command", arguments: "{}" },
							},
						]
					: []),
				{ type: "response_item", payload: { type: "function_call_output", call_id: "call", output } },
				...(metadata
					? [{ type: "event_msg", payload: { type: "exec_command_end", call_id: "call", ...metadata } }]
					: []),
			];
			await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
			const importer = new DesktopSessionImporter();
			const listing = await importer.list("codex", path);
			const preview = await importer.preview(listing.items[0].id);
			const tool = preview.actions.find((action) => action.kind === "tool")!;
			assert.equal(tool.status, expected);
			assert.equal(tool.output, output);
			const history = publicHistory({
				id: "import",
				project: root,
				name: "import",
				updated: 0,
				accountId: "",
				autoSwitch: false,
				actions: preview.actions,
			});
			assert.equal(history.outcomes[0].effect, expected === "done" ? "completed" : "unknown");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("R05: custom tool output preserves explicit native errors and uncertainty", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-custom-outcome-"));
	try {
		const path = join(root, "session.jsonl");
		await writeFile(
			path,
			`${[
				{ type: "session_meta", payload: { id: "session", cwd: root } },
				{
					type: "response_item",
					payload: { type: "custom_tool_call", call_id: "one", name: "custom", input: "patch" },
				},
				{
					type: "response_item",
					payload: { type: "custom_tool_call_output", call_id: "one", output: "partial", is_error: true },
				},
				{
					type: "response_item",
					payload: { type: "custom_tool_call", call_id: "two", name: "custom", input: "patch" },
				},
				{ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "two", output: "unknown" } },
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		const importer = new DesktopSessionImporter();
		const listing = await importer.list("codex", path);
		const preview = await importer.preview(listing.items[0].id);
		assert.deepEqual(
			preview.actions.map((action) => action.status),
			["error", "unknown"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
