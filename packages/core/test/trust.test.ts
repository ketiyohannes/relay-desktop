import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, ProjectTrustStore, SettingsManager } from "pi-sdk";
import { noTrustUI, resolveTrust } from "../src/runtimes/pi/trust.ts";

test("public trust hooks, stored denials, explicit overrides, and remembered parent choices", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-trust-"));
	try {
		const cwd = join(root, "project");
		const profile = join(root, "profile");
		await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
		await mkdir(profile);
		let decision: "yes" | "no" | "undecided" = "undecided";
		let calls = 0;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: profile,
			settingsManager: SettingsManager.inMemory(),
			disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
			extensionFactories: [
				{
					name: "trust-policy",
					factory: (pi) => {
						pi.on("project_trust", () => {
							calls++;
							return { trusted: decision, remember: true };
						});
					},
				},
			],
		});
		const extensions = await loader.loadProjectTrustExtensions();
		const store = new ProjectTrustStore(profile);
		store.set(cwd, false);
		const input = { cwd, profile, defaultTrust: "always" as const, extensions, context: noTrustUI(cwd) };
		assert.equal(await resolveTrust(input), false);
		decision = "yes";
		assert.equal(await resolveTrust(input), true);
		assert.equal(store.get(cwd), true);
		const prior = calls;
		assert.equal(await resolveTrust({ ...input, override: false }), false);
		assert.equal(calls, prior);
		decision = "undecided";
		store.set(cwd, null);
		const context = noTrustUI(cwd);
		context.hasUI = true;
		context.ui.select = async () => "Trust this session";
		assert.equal(await resolveTrust({ ...input, defaultTrust: "ask", context }), true);
		assert.equal(store.get(cwd), null);
		context.ui.select = async () => `Trust parent folder (${dirname(cwd)})`;
		assert.equal(await resolveTrust({ ...input, defaultTrust: "ask", context }), true);
		assert.equal(store.getEntry(cwd)?.path, root);
		store.set(cwd, false);
		assert.equal(await resolveTrust({ ...input, defaultTrust: "always" }), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
