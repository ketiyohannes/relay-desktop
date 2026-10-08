import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxThinking } from "pi-ai/providers/faux";
import { SessionManager } from "pi-sdk";
import { prepareHandoff } from "../src/handoffs/context.ts";
import { RelayApplication } from "../src/service/application.ts";
import { RelayServer } from "../src/service/server.ts";
import { nativeHistory, TerminalSessions } from "../src/terminal/sessions.ts";

test("native new/fork/resume preserves global identities and imports only the selected public branch", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-navigation-"));
	try {
		const app = new RelayApplication(join(root, "app"), []);
		await app.initialize();
		const server = new RelayServer(app, join(root, "app"));
		const router = new TerminalSessions({ request: (command) => server.command(command) }, "initial");
		const manager = SessionManager.inMemory(root);
		manager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "Early request" },
				{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
			],
			timestamp: 1,
		});
		const boundary = manager.appendMessage(
			fauxAssistantMessage([fauxThinking("private-reasoning-sentinel"), fauxText("Early reply")]),
		);
		manager.appendMessage({ role: "user", content: "Later request", timestamp: 2 });
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "write",
			toolName: "write",
			content: [{ type: "text", text: "Saved file" }],
			isError: false,
			timestamp: 3,
		});
		const selection = { backend: "pi" as const, profile: "", model: "faux", options: { provider: "faux" } };
		const initial = await router.resolve(manager);
		await router.register(manager, initial, selection, false);
		await app.append(initial.id, {
			type: "native",
			record: {
				id: "native",
				nativeId: manager.getSessionId(),
				selection,
				workspace: root,
				role: "foreground",
				branch: "main",
				receivedThrough: 0,
				status: "available",
			},
		});
		assert.equal(nativeHistory(manager).outcomes[0].outcome, JSON.stringify([{ type: "text", text: "Saved file" }]));
		assert.equal(JSON.stringify(nativeHistory(manager)).includes("private-reasoning-sentinel"), false);
		manager.branch(boundary);
		const fork = await router.resolve(manager, "fork");
		await router.register(manager, fork, selection, false);
		assert.equal(app.ledger.get(fork.id).parentSessionId, initial.id);
		assert.equal(app.ledger.get(fork.id).purpose, "branch");
		assert.equal(JSON.stringify(app.ledger.get(fork.id).events).includes("Later request"), false);
		const forkHistory = app.ledger.get(fork.id).events.find((event) => event.data.type === "import")?.data;
		assert.equal(forkHistory?.type, "import");
		if (forkHistory?.type !== "import") throw new Error("Missing imported branch");
		const forkImage = forkHistory.messages[0].attachments![0];
		assert.ok((await app.artifacts.resolve(fork.id, forkImage)).path.includes(fork.id));
		await assert.rejects(
			app.importHistory(fork.id, {
				...forkHistory,
				source: "forged",
				messages: [{ ...forkHistory.messages[0], attachments: [{ ...forkImage, uri: "file:///outside" }] }],
			}),
			/captured/,
		);
		const fresh = await router.resolve(SessionManager.inMemory(root), "new");
		assert.notEqual(fresh.id, fork.id);
		assert.equal(fresh.parentSessionId, undefined);
		assert.equal((await router.resolve(manager, "resume")).id, initial.id);
		manager.branch(boundary);
		const treeId = await router.navigate(manager);
		assert.equal(app.ledger.get(treeId).parentSessionId, initial.id);
		assert.equal(JSON.stringify(app.ledger.get(treeId).events).includes("Later request"), false);
		manager.appendCustomEntry("relay-product-session", { sessionId: treeId });
		const resumedRouter = new TerminalSessions({ request: (command) => server.command(command) }, "unused");
		assert.equal((await resumedRouter.resolve(manager)).id, treeId);
		manager.appendCustomMessageEntry("relay-native-display", "Foreign public reply", true, {
			sessionId: initial.id,
			history: {
				type: "import",
				source: "relay",
				messages: [
					{
						id: "foreign",
						role: "assistant",
						text: "Claude branch reply",
						attachments: [
							app.ledger
								.get(initial.id)
								.events.flatMap((event) =>
									event.data.type === "attachment" ? [event.data.attachment] : [],
								)[0],
						],
					},
				],
				outcomes: [],
			},
		});
		const foreign = await router.navigate(manager);
		assert.match(nativeHistory(manager).source, /^relay-pi-branch:/);
		assert.ok(
			app.ledger
				.get(foreign)
				.events.some(
					(event) =>
						event.data.type === "import" &&
						event.data.messages.some((message) => message.text === "Claude branch reply"),
				),
		);
		const portable = prepareHandoff(
			app.ledger.get(foreign),
			{
				id: "new-native",
				selection: { backend: "claude", model: "", profile: "" },
				workspace: root,
				branch: "main",
				role: "foreground",
				receivedThrough: 0,
				status: "available",
			},
			"Continue",
		);
		assert.equal(portable.artifacts.length, 2);
		assert.ok(portable.artifacts.every((artifact) => artifact.uri.includes(foreign)));
		const captured = await app.attach(foreign, "text/plain", "ZXZpZGVuY2U=", "Captured handoff evidence");
		manager.appendCustomMessageEntry("relay-handoff", "Historical evidence", false, {
			sessionId: foreign,
			handoff: {
				...portable,
				artifacts: [captured, { id: "policy", uri: "https://example.test/refunds", description: "Policy source" }],
			},
		});
		const evidenceBranch = await router.navigate(manager);
		const evidence = prepareHandoff(
			app.ledger.get(evidenceBranch),
			{
				id: "evidence-native",
				selection: { backend: "claude", model: "", profile: "" },
				workspace: root,
				branch: "main",
				role: "foreground",
				receivedThrough: 0,
				status: "available",
			},
			"Continue",
		);
		assert.ok(
			evidence.artifacts.some((artifact) => artifact.id === captured.id && artifact.uri.includes(evidenceBranch)),
		);
		assert.ok(evidence.artifacts.some((artifact) => artifact.uri === "https://example.test/refunds"));
		assert.equal(
			nativeHistory(manager).artifacts?.find((artifact) => artifact.id === captured.id)?.uri,
			captured.uri,
			"branch copying cannot mutate the source journal",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
