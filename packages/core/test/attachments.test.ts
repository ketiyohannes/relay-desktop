import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { RuntimeAdapter } from "../src/contracts.ts";
import { PermissionGate } from "../src/permissions/gate.ts";
import { RelayApplication } from "../src/service/application.ts";

test("attachments survive restart and switching as verified references; public history is scoped readable evidence", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-attachments-"));
	try {
		const directory = join(root, "app");
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const adapters: RuntimeAdapter[] = ["codex", "claude"].map((backend) => ({
			backend: backend as "codex" | "claude",
			discover: async () => ({
				resume: true,
				cancel: "interrupt",
				approvals: "native",
				compaction: "native",
				tools: [],
				mcp: false,
				limitations: [],
			}),
			open: async (open) => ({
				nativeId: backend,
				submit: async (input, emit) => {
					if (backend === "codex")
						assert.equal(await readFile(input.attachments![0].path, "utf8"), "Attached evidence");
					else assert.ok(input.handoff?.artifacts.some((artifact) => artifact.description === "evidence.txt"));
					assert.ok(input.handoff?.unresolved.some((note) => note.includes("relay-public-history.json")));
					const history = await readFile(open.historyPath!, "utf8");
					assert.match(history, /Attached evidence|evidence.txt/);
					assert.doesNotMatch(history, /receivedThrough|nativeDirectory|approvalPolicy/);
					const gate = new PermissionGate();
					assert.equal(
						await gate.check(
							"read-only",
							workspace,
							"Read",
							{ file_path: open.historyPath },
							async () => {},
							open.readPaths,
						),
						true,
					);
					assert.equal(
						await gate.check(
							"read-only",
							workspace,
							"Read",
							{ file_path: join(root, "outside") },
							async () => {},
							open.readPaths,
						),
						false,
					);
					await emit({ type: "accepted" });
					await emit({ type: "done", status: "completed" });
				},
				respond: async () => "expired",
				cancel: async () => "requested",
				release: async () => "settled",
			}),
		}));
		const app = new RelayApplication(directory, adapters);
		await app.initialize();
		await writeFile(join(root, "outside"), "Outside allowed roots");
		await app.create(workspace, { backend: "codex", model: "", profile: "" }, "Files", "session");
		const attachment = await app.attach(
			"session",
			"text/plain",
			Buffer.from("Attached evidence").toString("base64"),
			"evidence.txt",
		);
		assert.equal(
			await app.submit("session", "Inspect file", "read-only", "turn", undefined, undefined, [attachment.id]),
			"completed",
		);
		const restarted = new RelayApplication(directory, adapters);
		await restarted.initialize();
		await restarted.select("session", { backend: "claude", model: "", profile: "" });
		assert.equal(await restarted.submit("session", "Continue", "read-only"), "completed");
		await writeFile(fileURLToPath(attachment.uri), "Altered evidence");
		await assert.rejects(
			restarted.submit("session", "Inspect again", "ask", "changed", undefined, undefined, [attachment.id]),
			/missing or altered/,
		);
		assert.equal(restarted.ledger.get("session").turns.length, 2);
		await assert.rejects(app.attach("session", "text/plain", "YQ", "invalid"), /canonical base64/);
		await app.create(
			workspace,
			{ backend: "codex", model: "", profile: "" },
			"Private",
			"ephemeral",
			undefined,
			true,
		);
		await assert.rejects(app.attach("ephemeral", "text/plain", "YQ==", "private"), /ephemeral/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
