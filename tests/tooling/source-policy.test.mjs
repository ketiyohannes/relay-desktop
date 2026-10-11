import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { checkImport } from "../../scripts/source-policy.mjs";

test("core cannot depend on Electron or frontend modules", () => {
	const file = resolve("src/core/example.ts");
	for (const specifier of ["electron", "../main/index.ts", "../preload/index.ts", "../renderer/app.js", "@relay/desktop"])
		assert.ok(checkImport(file, specifier).length, specifier);
	assert.deepEqual(checkImport(file, "./contracts.ts"), []);
});

test("pi adapters use aliases and only published runtime entry points", () => {
	const file = resolve("src/core/example.ts");
	for (const specifier of ["@earendil-works/pi-agent-core", "pi-sdk/dist/core/agent-session.js", "pi-sdk/client", "pi-ai/providers/nonexistent"])
		assert.ok(checkImport(file, specifier).length, specifier);
	for (const specifier of ["pi-sdk", "pi-ai/providers/faux", "pi-tui"])
		assert.deepEqual(checkImport(file, specifier, true), []);
	assert.ok(checkImport(file, "vitest", true).length);
	assert.ok(checkImport(file, "./contracts.js").length);
});

test("features use published UI entry points and cannot reach process implementations", () => {
	const file = resolve("src/renderer/features/conversation/composer.js");
	assert.deepEqual(checkImport(file, "../settings/index.js", true), []);
	assert.ok(checkImport(file, "../accounts/model-picker.js", true).length);
	assert.ok(checkImport(file, "../../../core/service/application.ts", true).length);
	assert.ok(checkImport(file, "node:fs", true).length);
	assert.ok(checkImport(file, "electron", true).length);
	assert.deepEqual(checkImport(resolve("src/renderer/globals.d.ts"), "../core/desktop/types.ts", false, true), []);
});

test("shared behavior accepts desktop types but cannot call the desktop controller", () => {
	const file = resolve("src/core/sessions/example.ts");
	assert.ok(checkImport(file, "../desktop/commands.ts", true).length);
	assert.deepEqual(checkImport(file, "../desktop/types.ts", false, true), []);
});
