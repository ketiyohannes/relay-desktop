import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeAdapter } from "../src/contracts.ts";
import { RelayApplication } from "../src/service/application.ts";
import { RelayClient } from "../src/service/client.ts";
import { socketPath } from "../src/service/paths.ts";
import { RelayServer } from "../src/service/server.ts";

test("two frontends share one registry; unauthenticated local clients receive no events", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-service-"));
	const directory = join(root, "app");
	const app = new RelayApplication(directory, []);
	const server = new RelayServer(app, directory);
	let first: RelayClient | undefined;
	let second: RelayClient | undefined;
	try {
		await server.start();
		first = await RelayClient.connect(directory, false);
		second = await RelayClient.connect(directory, false);
		const observed: string[] = [];
		second.subscribe((event) => observed.push(event.sessionId));
		await second.request({ type: "list" });
		await first.request({
			type: "create",
			sessionId: "shared",
			workspace: root,
			selection: { backend: "codex", model: "", profile: "" },
		});
		const sessions = (await second.request({ type: "list" })) as { id: string }[];
		assert.equal(sessions[0].id, "shared");
		assert.deepEqual(observed, ["shared"]);
		const unauthenticated = connect(socketPath(directory));
		await new Promise<void>((resolve, reject) => {
			unauthenticated.once("connect", resolve);
			unauthenticated.once("error", reject);
		});
		let received = "";
		unauthenticated.on("data", (data: Buffer) => {
			received += data.toString();
		});
		const closed = new Promise<void>((resolve) => unauthenticated.once("close", () => resolve()));
		unauthenticated.write(
			`${JSON.stringify({ version: 1, id: "bad", token: "invalid", command: { type: "list" } })}\n`,
		);
		await closed;
		assert.equal(received, "");
	} finally {
		first?.close();
		second?.close();
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("disconnect cancels only the execution reserved by that socket", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-socket-owner-"));
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let cancellations = 0;
	const adapter: RuntimeAdapter = {
		backend: "codex",
		discover: async () => ({
			resume: true,
			cancel: "interrupt",
			approvals: "native",
			compaction: "native",
			tools: [],
			mcp: false,
			limitations: [],
		}),
		open: async () => ({
			nativeId: "native",
			submit: async (_input, emit) => {
				started();
				await pending;
				await emit({ type: "done", status: cancellations ? "cancelled" : "completed" });
			},
			respond: async () => "expired",
			cancel: async () => {
				cancellations++;
				finish();
				return "requested";
			},
			release: async () => "settled",
		}),
	};
	const directory = join(root, "app");
	const app = new RelayApplication(directory, [adapter]);
	const server = new RelayServer(app, directory);
	let first: RelayClient | undefined;
	let second: RelayClient | undefined;
	try {
		await server.start();
		first = await RelayClient.connect(directory, false);
		second = await RelayClient.connect(directory, false);
		await first.request({
			type: "create",
			sessionId: "session",
			workspace: root,
			selection: { backend: "codex", model: "", profile: "" },
		});
		const command = {
			type: "submit" as const,
			sessionId: "session",
			turnId: "turn",
			text: "Work",
			permissionMode: "ask" as const,
		};
		const run = first.request(command);
		void run.catch(() => {});
		await ready;
		assert.equal(await second.request(command), "running");
		second.close();
		await first.request({ type: "list" });
		assert.equal(cancellations, 0);
		first.close();
		await assert.rejects(run, /disconnected/);
		await pending;
		await app.wait("session");
		assert.equal(cancellations, 1);
		assert.equal(app.ledger.get("session").turns[0].status, "cancelled");
	} finally {
		finish();
		first?.close();
		second?.close();
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});
