import assert from "node:assert/strict";
import { test } from "node:test";
import { installComposer } from "../../../../src/renderer/features/conversation/composer.js";

function setup(t, command) {
	const elements = new Map();
	const get = (selector) => {
		if (!elements.has(selector)) elements.set(selector, {
			value: "", disabled: false, hidden: false, callbacks: new Map(),
			addEventListener(name, callback) { this.callbacks.set(name, callback); },
			trigger(name) { return this.callbacks.get(name)({ preventDefault() {} }); },
		});
		return elements.get(selector);
	};
	for (const [name, value] of Object.entries({
		document: { querySelector: get },
		window: { addEventListener() {} },
		localStorage: { getItem() { return null; } },
	})) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { configurable: true, value });
		t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
	}
	let activeId = "a";
	const errors = [];
	const composer = installComposer({
		getActiveId: () => activeId, command, notice: (error) => errors.push(error.message),
		render: () => { get("#send").disabled = composer.pending(); },
	});
	return { get, composer, errors, select(id) { composer.select(activeId, id); activeId = id; } };
}

test("a pending submission cannot erase a different session's draft or submit twice", async (t) => {
	let complete;
	const commands = [];
	const fixture = setup(t, (command) => {
		commands.push(command);
		return new Promise((resolve) => { complete = resolve; });
	});
	fixture.get("#prompt").value = "a prompt";
	const sending = fixture.get("#composer").trigger("submit");
	await fixture.get("#composer").trigger("submit");
	assert.equal(commands.length, 1);
	assert.equal(fixture.composer.pending(), true);
	fixture.select("b");
	fixture.get("#prompt").value = "b draft";
	complete();
	await sending;
	assert.equal(fixture.get("#prompt").value, "b draft");
	fixture.select("a");
	assert.equal(fixture.get("#prompt").value, "");
	fixture.select("b");
	assert.equal(fixture.get("#prompt").value, "b draft");
	assert.equal(fixture.composer.pending(), false);
});

test("a rejected submission retains its draft and allows another submission", async (t) => {
	const fixture = setup(t, async () => { throw new Error("Worker unavailable"); });
	fixture.get("#prompt").value = "keep this prompt";
	await fixture.get("#composer").trigger("submit");
	assert.equal(fixture.get("#prompt").value, "keep this prompt");
	assert.equal(fixture.get("#send").disabled, false);
	assert.deepEqual(fixture.errors, ["Worker unavailable"]);
	fixture.select("b");
	fixture.select("a");
	assert.equal(fixture.get("#prompt").value, "keep this prompt");
});
