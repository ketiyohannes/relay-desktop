import assert from "node:assert/strict";
import { test } from "node:test";
import { validateHostedEvent, validateSelection } from "../src/service/protocol.ts";

test("selections preserve supported options and discard secret-bearing unknown fields", () => {
	const selection = validateSelection({
		backend: "claude",
		profile: "/profile",
		model: "model",
		apiKey: "secret",
		options: {
			maxTurns: 4,
			projectInstructions: false,
			token: "secret",
			mcp: {
				browser: {
					command: "browser-server",
					args: ["--stdio"],
					envKeys: ["BROWSER_TOKEN"],
					env: { BROWSER_TOKEN: "secret" },
				},
			},
		},
	});
	assert.equal(JSON.stringify(selection).includes("secret"), false);
	assert.deepEqual(selection, {
		backend: "claude",
		profile: "/profile",
		model: "model",
		options: {
			maxTurns: 4,
			projectInstructions: false,
			mcp: { browser: { command: "browser-server", args: ["--stdio"], envKeys: ["BROWSER_TOKEN"] } },
		},
	});
	assert.throws(() => validateSelection({ backend: "codex", profile: "", model: "", options: { effort: "guess" } }));
	assert.throws(() => validateSelection({ backend: "pi", profile: "", model: "", options: { provider: "" } }));
	assert.throws(() => validateSelection({ backend: "claude", profile: "", model: "", options: { maxTurns: -1 } }));
	assert.throws(() =>
		validateSelection({
			backend: "codex",
			profile: "",
			model: "",
			options: { mcp: { bad: { command: "server", args: [], envKeys: "TOKEN" } } },
		}),
	);
});

test("hosted observations reject malformed payloads and service-owned state", () => {
	assert.throws(() => validateHostedEvent({ type: "tool_start", name: "bash", input: {} }));
	assert.throws(() => validateHostedEvent({ type: "text", id: "m", text: "hello", complete: "yes" }));
	assert.throws(() => validateHostedEvent({ type: "usage", usage: { cost: Number.NaN } }));
	assert.throws(() => validateHostedEvent({ type: "native_session", nativeId: "other" }));
	assert.throws(() => validateHostedEvent({ type: "done", status: "completed" }));
	assert.deepEqual(
		validateHostedEvent({ type: "text", id: "m", text: "hello", complete: true, reasoning: "private" }),
		{ type: "text", id: "m", text: "hello", complete: true },
	);
});
