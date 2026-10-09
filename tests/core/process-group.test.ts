import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { stopProcessGroup } from "../../src/core/runtimes/process-group.ts";

test(
	"native leader exit cannot release a group with a surviving tool process",
	{ skip: process.platform === "win32" },
	async () => {
		const child = spawn(process.execPath, [new URL("./fixtures/process-tree.mjs", import.meta.url).pathname], {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exited = once(child, "close").then(() => {});
		try {
			const [output] = await once(child.stdout, "data");
			const worker = Number(String(output).trim());
			assert.ok(worker > 0);
			const status = await stopProcessGroup(child, exited);
			if (status === "settled") assert.throws(() => process.kill(worker, 0), { code: "ESRCH" });
			else assert.equal(status, "unknown"); // Unreaped descendants quarantine ownership.
		} finally {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				/* Already stopped. */
			}
			await exited;
		}
	},
);
