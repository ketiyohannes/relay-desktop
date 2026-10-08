import { readFile } from "node:fs/promises";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "pi-ai";

/** Public CredentialStore contract; no imports of pi's private AuthStorage. */
export class ReadOnlyAuthStorage implements CredentialStore {
	private readonly path: string;
	constructor(path: string) {
		this.path = path;
	}
	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		try {
			return (JSON.parse(await readFile(this.path, "utf8")) as Record<string, Credential>)[providerId];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		try {
			return Object.entries(JSON.parse(await readFile(this.path, "utf8")) as Record<string, Credential>).map(
				([providerId, credential]) => ({ providerId, type: credential.type }),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}
	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const current = await this.read(providerId, options);
		const next = await fn(current);
		if (next !== current) throw new Error("Credential discovery is read-only; authenticate through the runtime");
		return current;
	}
	async delete(): Promise<void> {
		throw new Error("Credential discovery is read-only");
	}
}
