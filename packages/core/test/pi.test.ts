import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "pi-ai/providers/faux";
import { ModelRuntime, ProjectTrustStore } from "pi-sdk";
import type { OpenInput, RuntimeEvent } from "../src/contracts.ts";
import { PiAdapter } from "../src/runtimes/pi/adapter.ts";
import { ArtifactStore } from "../src/sessions/artifacts.ts";

test("published pi loop writes once, excludes reasoning, and resumes its native journal offline", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-pi-"));
	try {
		const profile = join(root, "profile");
		const native = join(root, "native");
		await mkdir(profile);
		await mkdir(native);
		const faux = fauxProvider({ provider: "relay-faux", tokensPerSecond: 100000 });
		const models = await ModelRuntime.create({
			authPath: join(profile, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		models.registerNativeProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: "once" }, { id: "write-once" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxThinking("private reasoning"), fauxText("Wrote the result")]),
		]);
		const adapter = new PiAdapter(async () => models);
		const input: OpenInput = {
			record: {
				id: "pi-native",
				workspace: root,
				branch: "main",
				selection: { backend: "pi", profile, model: faux.getModel().id, options: { provider: "relay-faux" } },
				role: "foreground",
				receivedThrough: 0,
				status: "available",
			},
			nativeDirectory: native,
			permissionMode: "ask",
		};
		const connection = await adapter.open(input);
		const events: RuntimeEvent[] = [];
		await connection.submit({ id: "turn", text: "Write result.txt", permissionMode: "ask" }, async (event) => {
			events.push(event);
			if (event.type === "approval") await connection.respond(event.id, true);
		});
		assert.equal(await readFile(join(root, "result.txt"), "utf8"), "once");
		assert.equal(events.filter((event) => event.type === "tool_start" && event.id === "write-once").length, 1);
		assert.equal(JSON.stringify(events).includes("private reasoning"), false);
		assert.ok(events.some((event) => event.type === "done" && event.status === "completed"));
		input.record.nativeId = connection.nativeId;
		await connection.release();
		faux.setResponses([fauxAssistantMessage("Continuing")]);
		const resumed = await adapter.open(input);
		assert.equal(resumed.nativeId, input.record.nativeId);
		await resumed.submit({ id: "next", text: "Continue", permissionMode: "ask" }, async (event) => {
			events.push(event);
		});
		await resumed.release();
		assert.equal(events.filter((event) => event.type === "tool_start" && event.id === "write-once").length, 1);
		assert.equal(faux.state.callCount, 3);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("read-only pi can delegate a bounded task without enabling write tools", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-pi-delegate-"));
	try {
		const profile = join(root, "profile");
		const native = join(root, "native");
		await mkdir(profile);
		await mkdir(native);
		const faux = fauxProvider({ provider: "relay-faux", tokensPerSecond: 100000 });
		const models = await ModelRuntime.create({
			authPath: join(profile, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		models.registerNativeProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("relay_delegate_task", { workerId: "browser", objective: "Find policy" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Policy found"),
		]);
		let delegated = 0;
		const connection = await new PiAdapter(async () => models).open({
			record: {
				id: "worker-parent",
				workspace: root,
				branch: "main",
				selection: { backend: "pi", profile, model: faux.getModel().id, options: { provider: "relay-faux" } },
				role: "foreground",
				receivedThrough: 0,
				status: "available",
			},
			nativeDirectory: native,
			permissionMode: "read-only",
			delegate: async (request) => {
				delegated++;
				assert.equal(request.workerId, "browser");
				return {
					status: "completed",
					summary: "Policy",
					findings: [],
					evidence: [],
					actions: [],
					finalEnvironment: { workspace: root, state: "closed" },
					blockers: [],
					pendingApprovalIds: [],
				};
			},
		});
		await connection.submit({ id: "turn", text: "Find the policy", permissionMode: "read-only" }, async () => {});
		await connection.release();
		assert.equal(delegated, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("public pi services register extension providers before model lookup and gate project extensions by trust", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-pi-resources-"));
	try {
		const profile = join(root, "profile");
		const project = join(root, "project");
		const native = join(root, "native");
		await mkdir(join(profile, "extensions"), { recursive: true });
		await mkdir(join(project, ".pi", "extensions"), { recursive: true });
		await mkdir(native);
		await symlink(
			fileURLToPath(new URL("../../../node_modules", import.meta.url)),
			join(root, "node_modules"),
			"dir",
		);
		await writeFile(
			join(profile, "extensions", "faux.ts"),
			`import { fauxProvider, fauxAssistantMessage } from "pi-ai/providers/faux";
export default function (pi) {
  const faux = fauxProvider({ provider: "extension-faux", models: [{ id: "test" }], tokensPerSecond: 100000 });
  faux.setResponses([fauxAssistantMessage("Extension provider reply")]);
  pi.registerProvider(faux.provider);
}`,
		);
		await writeFile(
			join(project, ".pi", "extensions", "project.ts"),
			`import { writeFileSync } from "node:fs";
export default function () { writeFileSync(${JSON.stringify(join(project, "loaded"))}, "trusted"); }`,
		);
		const input: OpenInput = {
			record: {
				id: "resources",
				workspace: project,
				branch: "main",
				selection: { backend: "pi", profile, model: "test", options: { provider: "extension-faux" } },
				role: "foreground",
				receivedThrough: 0,
				status: "available",
			},
			nativeDirectory: native,
			permissionMode: "read-only",
		};
		const connection = await new PiAdapter().open(input);
		await assert.rejects(readFile(join(project, "loaded")), /ENOENT/);
		const events: RuntimeEvent[] = [];
		await connection.submit({ id: "turn", text: "Reply", permissionMode: "read-only" }, async (event) => {
			events.push(event);
		});
		assert.ok(
			events.some((event) => event.type === "text" && event.complete && event.text === "Extension provider reply"),
		);
		await connection.release();
		new ProjectTrustStore(profile).set(project, true);
		const trusted = await new PiAdapter().open(input);
		assert.equal(await readFile(join(project, "loaded"), "utf8"), "trusted");
		await trusted.release();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("published pi receives image blocks and rejects text-only models before inference", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-pi-images-"));
	try {
		const profile = join(root, "profile");
		await mkdir(profile);
		const artifacts = new ArtifactStore(join(root, "artifacts"));
		const imageData =
			"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8AAQv8ZYAwAQ84H+VjtZqAAAAAASUVORK5CYII=";
		const reference = await artifacts.capture("session", "image/png", imageData, "Image evidence");
		const attachment = await artifacts.resolve("session", reference);
		const faux = fauxProvider({
			provider: "relay-images",
			models: [
				{ id: "vision", input: ["text", "image"] },
				{ id: "text", input: ["text"] },
			],
			tokensPerSecond: 100000,
		});
		const models = await ModelRuntime.create({
			authPath: join(profile, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		models.registerNativeProvider(faux.provider);
		let observed = false;
		faux.setResponses([
			(context) => {
				const user = context.messages.findLast((message) => message.role === "user");
				assert.ok(user?.role === "user" && Array.isArray(user.content));
				assert.ok(
					user.content.some(
						(block) =>
							block.type === "image" &&
							block.data.length > 0 &&
							["image/png", "image/jpeg"].includes(block.mimeType),
					),
					JSON.stringify(user.content),
				);
				observed = true;
				return fauxAssistantMessage("Image received");
			},
		]);
		for (const model of ["vision", "text"]) {
			const native = join(root, model);
			await mkdir(native);
			const connection = await new PiAdapter(async () => models).open({
				record: {
					id: model,
					workspace: root,
					branch: "main",
					role: "foreground",
					receivedThrough: 0,
					status: "available",
					selection: { backend: "pi", profile, model, options: { provider: "relay-images" } },
				},
				nativeDirectory: native,
				permissionMode: "read-only",
			});
			try {
				const events: RuntimeEvent[] = [];
				await connection.submit(
					{ id: model, text: "Inspect image", permissionMode: "read-only", attachments: [attachment] },
					async (event) => {
						events.push(event);
					},
				);
				assert.ok(
					events.some(
						(event) => event.type === "done" && event.status === (model === "vision" ? "completed" : "failed"),
					),
					JSON.stringify(events),
				);
			} finally {
				await connection.release();
			}
		}
		assert.equal(observed, true);
		assert.equal(faux.state.callCount, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
