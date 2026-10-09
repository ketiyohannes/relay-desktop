import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { serviceBuild } from "../../src/core/service/build.ts";
import { RelayClient, RelayServiceVersionError } from "../../src/core/service/client.ts";
import { socketPath } from "../../src/core/service/paths.ts";
import type { Request } from "../../src/core/service/protocol.ts";

for (const active of [false, true]) {
	test(`a mismatched service ${active ? "keeps active execution untouched" : "releases its lock before the replacement starts"}`, async () => {
		const directory = await mkdtemp(join(await realpath(tmpdir()), "relay-upgrade-"));
		const commands: string[] = [];
		const server = createServer((socket) => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (data: string) => {
				buffer += data;
				for (;;) {
					const index = buffer.indexOf("\n");
					if (index < 0) break;
					const request = JSON.parse(buffer.slice(0, index)) as Request;
					buffer = buffer.slice(index + 1);
					commands.push(request.command.type);
					if (request.command.type === "hello")
						socket.write(
							`${JSON.stringify({ version: 1, id: request.id, result: { build: "previous-build", activeSessions: active ? ["ongoing"] : [] } })}\n`,
						);
					else if (request.command.type === "upgrade") {
						assert.equal(request.command.build, "previous-build");
						socket.write(`${JSON.stringify({ version: 1, id: request.id, result: { upgrading: true } })}\n`);
						void (async () => {
							await delay(20);
							socket.destroy();
							await new Promise<void>((resolve) => server.close(() => resolve()));
							await delay(150); // Simulate slow lock cleanup after the socket closes.
							await rm(join(directory, "service.lock"), { recursive: true });
						})();
					}
				}
			});
		});
		let client: RelayClient | undefined;
		try {
			await mkdir(join(directory, "service.lock"));
			await writeFile(join(directory, "service.lock/owner.json"), JSON.stringify({ pid: process.pid }));
			await writeFile(join(directory, "service.token"), "offline-token");
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath(directory), resolve);
			});
			if (active) {
				await assert.rejects(RelayClient.connect(directory), RelayServiceVersionError);
				assert.deepEqual(commands, ["hello"]);
				assert.equal(server.listening, true);
			} else {
				client = await RelayClient.connect(directory);
				const hello = (await client.request({ type: "hello" })) as { build: string; pid: number };
				assert.equal(hello.build, await serviceBuild());
				assert.notEqual(hello.pid, process.pid);
				assert.deepEqual(commands, ["hello", "upgrade"]);
				await client.request({ type: "upgrade", build: hello.build });
				for (let attempt = 0; attempt < 100; attempt++) {
					try {
						await readFile(join(directory, "service.lock/owner.json"));
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
						throw error;
					}
					await delay(25);
				}
				await assert.rejects(readFile(join(directory, "service.lock/owner.json")), /ENOENT/);
			}
		} finally {
			client?.close();
			if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		}
	});
}
