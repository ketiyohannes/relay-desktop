import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncDirectory, writePrivateFile } from "./durable.ts";

interface Owner {
	pid: number;
	token: string;
}

/** For process-owned writers only. Native workspace leases must never use PID recovery. */
export class ProcessLock {
	private readonly path: string;
	private readonly owner: Owner;
	private constructor(path: string, owner: Owner) {
		this.path = path;
		this.owner = owner;
	}
	static async acquire(path: string, depth = 0): Promise<ProcessLock> {
		if (depth > 16)
			throw new Error(
				`Lock recovery chain is too deep: ${path}. Stop Relay processes and move the lock directories aside before restarting.`,
			);
		const owner = { pid: process.pid, token: randomUUID() };
		const candidate = `${path}.candidate-${owner.token}`;
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await mkdir(candidate, { mode: 0o700 });
		try {
			await writePrivateFile(join(candidate, "owner.json"), JSON.stringify(owner));
			await syncDirectory(candidate);
			let claimed = false;
			try {
				// A populated directory is committed atomically; there is no ownerless lock window.
				await rename(candidate, path);
				claimed = true;
			} catch (error) {
				// Existing-directory rename errors differ across platforms. Establish
				// whether a lock is present before inspecting its ownership.
				const existing = await lstat(path).catch((failure: NodeJS.ErrnoException) => {
					if (failure.code === "ENOENT") return undefined;
					throw failure;
				});
				if (!existing?.isDirectory()) throw error;
			}
			if (claimed) {
				await syncDirectory(dirname(path));
				return new ProcessLock(path, owner);
			}
			let previous: Owner;
			try {
				previous = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Owner;
				if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error("Invalid owner PID");
			} catch (error) {
				throw new Error(
					`Cannot establish lock ownership at ${path}: ${String(error)}. Stop all Relay desktop and service processes, move this lock directory aside, then restart Relay. Session journals must remain in place.`,
				);
			}
			try {
				process.kill(previous.pid, 0);
				throw new Error(`Writer already running (PID ${previous.pid}): ${path}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
			// Recovery belongs to this exact dead generation. A competing recovery cannot
			// remove a newer writer, even when a previous recovery process died itself.
			const generation = createHash("sha256").update(JSON.stringify(previous)).digest("hex");
			const recovery = await ProcessLock.acquire(`${path}.recover-${generation}`, depth + 1);
			try {
				const actual = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Owner;
				if (JSON.stringify(actual) !== JSON.stringify(previous)) throw new Error("Lock owner changed; retry startup");
				const obsolete = `${path}.dead-${owner.token}`;
				await rename(path, obsolete);
				try {
					await rename(candidate, path);
					await syncDirectory(dirname(path));
					return new ProcessLock(path, owner);
				} finally {
					await rm(obsolete, { recursive: true });
				}
			} finally {
				await recovery.release();
			}
		} finally {
			await rm(candidate, { recursive: true, force: true });
		}
	}
	async release(): Promise<void> {
		const actual = JSON.parse(await readFile(join(this.path, "owner.json"), "utf8")) as Owner;
		if (actual.token !== this.owner.token) throw new Error("Writer lock owner changed");
		const released = `${this.path}.released-${this.owner.token}`;
		await rename(this.path, released);
		await rm(released, { recursive: true });
		await syncDirectory(dirname(this.path));
	}
}
