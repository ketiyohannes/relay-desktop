import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RelayApplication } from "../src/service/application.ts";
import { RelayServer } from "../src/service/server.ts";

test("CLI replays public imports and final text once, suppresses stale approvals, and buffers piped quit", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-cli-"));
	const directory = join(root, "app");
	const app = new RelayApplication(directory, []);
	const server = new RelayServer(app, directory);
	try {
		await server.start();
		await app.create(root, { backend: "codex", model: "", profile: "" }, "Saved", "saved");
		await app.importHistory("saved", {
			type: "import",
			source: "native-import",
			messages: [{ id: "m", role: "user", text: "Imported request" }],
			outcomes: [{ eventId: "o", tool: "write", outcome: "File already saved", effect: "completed" }],
		});
		await app.recordNote("saved", { id: "review", kind: "review", text: "Review started", status: "running" });
		await app.recordNote("saved", { id: "review", kind: "review", text: "Review complete", status: "done" });
		for (const complete of [false, true])
			await app.append("saved", {
				type: "runtime",
				nativeRecordId: "native",
				turnId: "turn",
				event: { type: "text", id: "reply", text: "Saved answer", complete },
			});
		const approval = {
			id: "stale",
			nativeRecordId: "native",
			turnId: "turn",
			tool: "bash",
			input: {},
			expiresAt: Date.now() + 120000,
			status: "pending" as const,
		};
		await app.append("saved", { type: "approval", approval });
		await app.append("saved", { type: "approval", approval: { ...approval, status: "denied" } });
		await app.append("saved", { type: "approval", approval: { ...approval, id: "current" } });
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "chat", "--session", "saved"],
			{ env: { ...process.env, RELAY_APP_DIR: directory }, stdio: ["pipe", "pipe", "pipe"] },
		);
		let output = "";
		let errors = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			errors += chunk.toString();
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
		try {
			child.stdin.end("/quit\n");
			const code = await new Promise<number | null>((resolve, reject) => {
				child.once("exit", resolve);
				child.once("error", reject);
			});
			assert.equal(code, 0, errors);
			assert.match(output, /Imported request/);
			assert.match(output, /File already saved/);
			assert.match(output, /Review complete/);
			assert.doesNotMatch(output, /Review started/);
			assert.equal(output.split("Saved answer").length - 1, 1);
			assert.doesNotMatch(output, /Approval stale/);
			assert.match(output, /Approval current/);
		} finally {
			clearTimeout(timer);
			child.kill();
		}
		// Failure during snapshot loading must also close readline with stdin still open.
		const missing = spawn(
			process.execPath,
			[fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "chat", "--session", "missing"],
			{ env: { ...process.env, RELAY_APP_DIR: directory }, stdio: ["pipe", "ignore", "pipe"] },
		);
		missing.stderr.resume();
		const timeout = setTimeout(() => missing.kill("SIGKILL"), 10000);
		try {
			assert.equal(
				await new Promise<number | null>((resolve, reject) => {
					missing.once("exit", resolve);
					missing.once("error", reject);
				}),
				1,
			);
		} finally {
			clearTimeout(timeout);
			missing.kill();
		}
	} finally {
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});
