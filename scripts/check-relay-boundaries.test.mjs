import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { checkSource } from "./check-relay-boundaries.mjs";

test("Relay boundary checker rejects type imports and private or local pi internals", () => {
	const file = resolve("packages/core/src/example.ts");
	for (const source of [
		'import type { Agent } from "../../agent/src/index.ts";',
		'import { Agent } from "@earendil-works/pi-agent-core";',
		'import { Agent } from "pi-sdk/dist/core/agent-session.js";',
		'const runtime = await import("pi-sdk");',
	]) assert.ok(checkSource(file, source).length);
	assert.deepEqual(checkSource(file, 'import { SessionManager } from "pi-sdk"; import { fauxProvider } from "pi-ai/providers/faux";'), []);
	assert.deepEqual(checkSource(file, 'import { SessionManager } from "pi-sdk"; if (/^#\\s*AGENTS/.test(value)) return "safe";'), []);
});

test("shared core cannot depend on a frontend", () => {
    const file = resolve("packages/core/src/example.ts");
    assert.ok(checkSource(file, 'import { app } from "../../../apps/desktop/src/main.ts";').length);
    assert.ok(checkSource(file, 'import { app } from "@relay/desktop";').length);
});
