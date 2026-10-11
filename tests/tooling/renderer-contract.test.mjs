import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("R09: the renderer gate rejects incorrect bridge commands and response fields", async () => {
	const directory = await mkdtemp(join(tmpdir(), "relay-renderer-contract-"));
	try {
		const source = join(directory, "bridge.js");
		const config = join(directory, "tsconfig.json");
		await writeFile(config, JSON.stringify({
			extends: resolve("tsconfig.renderer.json"),
			compilerOptions: { typeRoots: [resolve("node_modules/@types")] },
			include: [resolve("src/renderer/globals.d.ts"), source],
		}));
		const check = () => spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--project", config, "--noEmit"], { encoding: "utf8" });
		await writeFile(source, 'window.relay.command({ type: "editor_read", sessionId: "test", path: "file" }).then(file => file.content.toUpperCase());\n');
		const valid = check();
		assert.equal(valid.status, 0, valid.stdout + valid.stderr);
		await writeFile(source, 'window.relay.command({ type: "editor_read", sessionId: "test", path: "file" }).then(file => file.missingField);\nwindow.relay.command({ type: "invalid_command" });\n');
		const invalid = check();
		assert.notEqual(invalid.status, 0, invalid.stdout + invalid.stderr);
		assert.match(invalid.stdout, /missingField/);
		assert.match(invalid.stdout, /invalid_command/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
