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
