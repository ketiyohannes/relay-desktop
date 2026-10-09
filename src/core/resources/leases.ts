import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory, writePrivateFile } from "../storage/durable.ts";

export interface ResourceLease {
	resource: string;
	token: string;
	owner: string;
	pid: number;
}

/** Locks are not reclaimed by time or dead PID: native tools may outlive their host. */
export class ResourceLeases {
	readonly directory: string;
	constructor(directory: string) {
		this.directory = directory;
	}
	private path(resource: string): string {
		return join(this.directory, createHash("sha256").update(resource).digest("hex"));
	}
	async acquire(resource: string, owner: string): Promise<ResourceLease> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const path = this.path(resource);
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new Error(`Resource locked or quarantined: ${resource}. Reconcile its previous execution before reuse.`);
			throw error;
		}
		const lease = { resource, owner, token: randomUUID(), pid: process.pid };
		try {
			await writePrivateFile(join(path, "owner.json"), JSON.stringify(lease));
			await syncDirectory(path);
			await syncDirectory(this.directory);
		} catch (error) {
			await rm(path, { recursive: true });
			throw error;
		}
		return lease;
	}
	async release(lease: ResourceLease): Promise<void> {
		const actual = JSON.parse(await readFile(join(this.path(lease.resource), "owner.json"), "utf8")) as ResourceLease;
		if (actual.token !== lease.token) throw new Error("Resource fencing token mismatch");
		await rm(this.path(lease.resource), { recursive: true });
		await syncDirectory(this.directory);
	}
	async owner(resource: string): Promise<ResourceLease | undefined> {
		try {
			return JSON.parse(await readFile(join(this.path(resource), "owner.json"), "utf8")) as ResourceLease;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	async reconcile(resource: string, owners: string[]): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		// Explicit operator action only, after checking native execution and environment.
		try {
			const lease = JSON.parse(await readFile(join(this.path(resource), "owner.json"), "utf8")) as ResourceLease;
			if (!owners.includes(lease.owner))
				throw new Error("Resource belongs to a different execution; reconcile its owner");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await rm(this.path(resource), { recursive: true, force: true });
		await syncDirectory(this.directory);
	}
}
