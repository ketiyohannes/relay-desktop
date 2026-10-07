import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { ModelRuntime } from "../core/model-runtime.ts";
import type { DesktopAccount, DesktopLogin } from "./types.ts";

export type LoginProvider = (
	provider: "codex" | "claude",
	directory: string,
	interaction: AuthInteraction,
) => Promise<string>;

/** Only authorization links leave the CLI adapter. Its raw output may contain secrets. */
export function claudeLoginUrl(output: string): string | undefined {
	for (const value of output.match(/https:\/\/[^\s\x1b<>"']+/g) ?? []) {
		try {
			const url = new URL(value);
			if (
				["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"].includes(url.hostname) &&
				url.pathname.includes("oauth") &&
				!url.username &&
				!url.password
			)
				return url.href;
		} catch {
			/* Ignore partial chunks and terminal decoration. */
		}
	}
	return undefined;
}

export const loginProvider: LoginProvider = async (provider, directory, interaction) => {
	if (provider === "codex") {
		const runtime = await ModelRuntime.create({
			authPath: join(directory, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		await runtime.login("openai-codex", "oauth", interaction);
		const models = runtime.getModels("openai-codex");
		const model = models.find((model) => model.id === "gpt-6.1-sol") ?? models.at(-1);
		if (!model) throw new Error("Codex model catalog unavailable");
		return model.id;
	}
	const require = createRequire(import.meta.url);
	const binary = require.resolve(
		`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${process.platform === "win32" ? "claude.exe" : "claude"}`,
	);
	const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: directory };
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"CLAUDE_SECURESTORAGE_CONFIG_DIR",
	])
		delete env[key];
	const execute = (args: string[], login: boolean): Promise<string> =>
		new Promise((resolve, reject) => {
			const child = spawn(binary, args, {
				cwd: directory,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				signal: interaction.signal,
			});
			let output = "";
			let lastUrl = "";
			let promptOpened = false;
			const promptAbort = new AbortController();
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const cancel = () => {
				killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
			};
			interaction.signal?.addEventListener("abort", cancel, { once: true });
			const receive = (data: Buffer) => {
				output = (output + data.toString()).slice(-32768);
				if (!login) return;
				const url = claudeLoginUrl(output);
				if (url && url !== lastUrl) {
					lastUrl = url;
					interaction.notify({
						type: "auth_url",
						url,
						instructions: "Complete Claude sign-in in your browser. Relay will save the account automatically.",
					});
				}
				if (!promptOpened && /paste.*code.*here/i.test(output)) {
					promptOpened = true;
					void interaction
						.prompt({
							type: "manual_code",
							message: "If Claude asks you to copy a code, paste it here. Otherwise finish in your browser.",
							signal: promptAbort.signal,
						})
						.then(
							(value) => {
								if (!promptAbort.signal.aborted && !interaction.signal?.aborted)
									child.stdin.write(`${value.replace(/[\r\n]/g, "")}\n`);
							},
							() => {},
						);
				}
			};
			child.stdout.on("data", receive);
			child.stderr.on("data", receive);
			child.stdin.on("error", () => {});
			child.on("error", (error) => {
				if (error.name !== "AbortError") reject(error);
			});
			child.on("close", (code) => {
				promptAbort.abort();
				if (killTimer) clearTimeout(killTimer);
				interaction.signal?.removeEventListener("abort", cancel);
				if (code === 0 && !interaction.signal?.aborted) resolve(output);
				else reject(new Error("Claude sign-in failed. Cancel and try again."));
			});
		});
	interaction.notify({ type: "progress", message: "Opening Claude authorization. Complete sign-in in your browser." });
	await execute(["auth", "login", "--claudeai"], true);
	const status = JSON.parse(await execute(["auth", "status", "--json"], false)) as { loggedIn?: boolean };
	if (!status.loggedIn) throw new Error("Claude did not save an authenticated profile");
	return "sonnet";
};

export class DesktopLoginManager {
	get busy(): boolean {
		return !!this.active;
	}
	private active?: { abort: AbortController; done: Promise<void> };
	private pending?: { id: string; answer(value: string): void };
	private current?: DesktopLogin;
	private readonly directory: string;
	private readonly emit: (state: DesktopLogin) => void;
	private readonly save: (account: DesktopAccount) => Promise<void>;
	private readonly provider: LoginProvider;
	constructor(
		directory: string,
		emit: (state: DesktopLogin) => void,
		save: (account: DesktopAccount) => Promise<void>,
		provider: LoginProvider = loginProvider,
	) {
		this.directory = directory;
		this.emit = emit;
		this.save = save;
		this.provider = provider;
	}
	private update(state: DesktopLogin): void {
		this.current = state;
		this.emit(state);
	}
	start(provider: "codex" | "claude", name: string): void {
		if (this.active) throw new Error("Cancel the current sign-in first");
		if (!["codex", "claude"].includes(provider) || typeof name !== "string" || !name.trim() || name.length > 120)
			throw new Error("Enter an account name");
		const abort = new AbortController();
		const id = randomUUID();
		const directory = join(this.directory, "accounts", id);
		this.update({ status: "running", message: "Starting sign-in…" });
		const done = this.run(provider, name.trim(), id, directory, abort);
		this.active = { abort, done };
	}
	private async run(
		provider: "codex" | "claude",
		name: string,
		id: string,
		directory: string,
		abort: AbortController,
	): Promise<void> {
		const timeout = setTimeout(() => abort.abort(), 15 * 60 * 1000);
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			abort.signal.throwIfAborted();
			const model = await this.provider(provider, directory, {
				signal: abort.signal,
				notify: (event) => {
					if (abort.signal.aborted) return;
					const base: DesktopLogin = { ...this.current, status: "running", message: "Waiting for authorization" };
					if (event.type === "auth_url") {
						base.url = event.url;
						base.message = event.instructions || base.message;
					} else if (event.type === "device_code") {
						base.url = event.verificationUri;
						base.code = event.userCode;
					} else base.message = event.message;
					this.update(base);
				},
				prompt: (prompt) =>
					new Promise<string>((resolve, reject) => {
						const promptId = randomUUID();
						const cleanup = () => {
							abort.signal.removeEventListener("abort", cancel);
							prompt.signal?.removeEventListener("abort", cancel);
							if (this.pending?.id === promptId) this.pending = undefined;
						};
						const cancel = () => {
							cleanup();
							if (this.current?.prompt?.id === promptId) this.update({ ...this.current, prompt: undefined });
							reject(new Error("Sign-in prompt cancelled"));
						};
						if (abort.signal.aborted || prompt.signal?.aborted) {
							cancel();
							return;
						}
						this.pending = {
							id: promptId,
							answer: (value) => {
								cleanup();
								this.update({ ...this.current!, prompt: undefined });
								resolve(value);
							},
						};
						abort.signal.addEventListener("abort", cancel, { once: true });
						prompt.signal?.addEventListener("abort", cancel, { once: true });
						this.update({
							...this.current!,
							prompt: {
								id: promptId,
								type: prompt.type,
								message: prompt.message,
								...(prompt.type === "select" ? { options: prompt.options } : {}),
							},
						});
					}),
			});
			abort.signal.throwIfAborted();
			await this.save({
				id,
				name,
				engine: provider === "claude" ? "claude" : "pi",
				configDir: directory,
				provider: provider === "codex" ? "openai-codex" : "",
				model,
				credentialSource: "pi",
			});
			this.update({ status: "success", message: `${name} connected` });
		} catch {
			await rm(directory, { recursive: true, force: true }).catch(() => {});
			this.update({
				status: abort.signal.aborted ? "cancelled" : "error",
				message: abort.signal.aborted
					? "Sign-in cancelled"
					: "Sign-in failed. Try again or connect an existing profile.",
			});
		} finally {
			clearTimeout(timeout);
			this.pending = undefined;
			this.active = undefined;
		}
	}
	reply(id: string, value: string): void {
		if (this.pending?.id !== id || typeof value !== "string" || value.length > 16384)
			throw new Error("Sign-in prompt expired");
		const options = this.current?.prompt?.options;
		if (options && !options.some((option) => option.id === value)) throw new Error("Invalid sign-in method");
		this.pending.answer(value);
	}
	async cancel(): Promise<void> {
		const active = this.active;
		active?.abort.abort();
		await active?.done;
	}
}
