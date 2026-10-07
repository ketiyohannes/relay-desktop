import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { FileAuthStorageBackend } from "../core/auth-storage.ts";

interface CodexAuthFile {
	auth_mode?: string;
	tokens?: { access_token?: string; refresh_token?: string; account_id?: string; id_token?: string };
	[key: string]: unknown;
}

function credential(data: CodexAuthFile): Credential | undefined {
	const tokens = data.tokens;
	if (data.auth_mode !== "chatgpt" || !tokens?.access_token || !tokens.refresh_token) return undefined;
	const payload = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString()) as {
		exp?: number;
	};
	if (!payload.exp) throw new Error("Codex access token has no expiry");
	return {
		type: "oauth",
		access: tokens.access_token,
		refresh: tokens.refresh_token,
		expires: payload.exp * 1000,
		accountId: tokens.account_id,
	};
}

/** Use Codex's existing OAuth file directly; refresh stays in its original profile. */
export class CodexAuthStorage implements CredentialStore {
	readonly path: string;
	constructor(directory = join(homedir(), ".codex")) {
		this.path = join(directory, "auth.json");
	}
	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		if (providerId !== "openai-codex") return undefined;
		try {
			return credential(JSON.parse(await readFile(this.path, "utf8")) as CodexAuthFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return (await this.read("openai-codex", options)) ? [{ providerId: "openai-codex", type: "oauth" }] : [];
	}
	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		if (providerId !== "openai-codex") throw new Error("Codex profile only supports openai-codex");
		await stat(this.path);
		return new FileAuthStorageBackend(this.path).withLockAsync(async (content) => {
			const data = JSON.parse(content || "{}") as CodexAuthFile;
			const current = credential(data);
			const next = await fn(current);
			if (!next || next === current) return { result: current };
			if (next.type !== "oauth") throw new Error("Codex profile requires OAuth credentials");
			const updated = {
				...data,
				tokens: {
					...data.tokens,
					access_token: next.access,
					refresh_token: next.refresh,
					account_id: next.accountId,
				},
				last_refresh: new Date().toISOString(),
			};
			return { result: next, next: JSON.stringify(updated, null, 2) };
		}, options);
	}
	async delete(): Promise<void> {
		throw new Error("Relay cannot log out a native Codex profile");
	}
}
