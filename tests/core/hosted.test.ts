import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiAdapter } from "../../src/core/runtimes/pi/adapter.ts";
import { RelayApplication } from "../../src/core/service/application.ts";
import { HostedConnection } from "../../src/core/service/hosted.ts";

test("frontend-hosted pi uses the same global execution lease without creating another agent loop", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-hosted-"));
	try {
		const app = new RelayApplication(join(root, "app"), [new PiAdapter()]);
		await app.initialize();
		const session = await app.create(root, {
			backend: "pi",
			profile: "",
			model: "faux",
			options: { provider: "faux" },
		});
		const host = new HostedConnection("native", "turn", () => true);
		const execution = app.submit(session.id, "Work", "ask", "turn", {
			connection: host,
			nativeFile: "/opaque/native.jsonl",
		});
		const input = await host.ready;
		assert.equal(input.text, "Work");
		await assert.rejects(app.resources.acquire(`workspace:${root}`, "other"), /Resource locked/);
		await host.event({ type: "accepted" });
		await host.event({ type: "tool_start", id: "write", name: "write", input: { path: "file" } });
		await host.event({ type: "tool_end", id: "write", name: "write", output: "saved", failed: false });
		await host.complete("completed");
		assert.equal(await execution, "completed");
		assert.equal(app.ledger.get(session.id).natives[0].nativeFile, "/opaque/native.jsonl");
		const lease = await app.resources.acquire(`workspace:${root}`, "other");
		await app.resources.release(lease);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a disconnected terminal quarantines effects even if its native process may still act", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-hosted-crash-"));
	try {
		const app = new RelayApplication(join(root, "app"), [new PiAdapter()]);
		await app.initialize();
		const session = await app.create(root, {
			backend: "pi",
			profile: "",
			model: "faux",
			options: { provider: "faux" },
		});
		const controls: string[] = [];
		const host = new HostedConnection("native", "turn", (control) => {
			controls.push(control.type);
			return true;
		});
		const execution = app.submit(session.id, "Work", "ask", "turn", { connection: host });
		await host.ready;
		assert.equal(await app.cancel(session.id), "requested");
		assert.deepEqual(controls, ["cancel"]);
		host.disconnect();
		assert.equal(await execution, "unknown");
		await assert.rejects(app.submit(session.id, "Replay"), /Reconcile/);
		await assert.rejects(app.resources.acquire(`workspace:${root}`, "other"), /Resource locked/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("changing the model in one hosted journal does not replay its own conversation", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-hosted-model-"));
	try {
		const app = new RelayApplication(join(root, "app"), [new PiAdapter()]);
		await app.initialize();
		const selection = { backend: "pi" as const, profile: "", model: "first", options: { provider: "faux" } };
		const session = await app.create(root, selection);
		const first = new HostedConnection("native", "first", () => true);
		const execution = app.submit(session.id, "Initial request", "ask", "first", { connection: first });
		await first.ready;
		await first.event({ type: "accepted" });
		await first.event({ type: "text", id: "answer", text: "Already seen", complete: true });
		await first.complete("completed");
		await execution;
		await app.select(session.id, { ...selection, model: "second" });
		const second = new HostedConnection("native", "second", () => true);
		const continued = app.submit(session.id, "Continue", "ask", "second", { connection: second });
		const input = await second.ready;
		assert.equal(
			input.handoff?.conversation.some(
				(message) => message.text === "Already seen" || message.text === "Initial request",
			),
			false,
		);
		await second.complete("completed");
		await continued;
		assert.equal(app.ledger.get(session.id).natives.length, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
