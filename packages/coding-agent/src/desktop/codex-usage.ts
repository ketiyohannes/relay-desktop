import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface CodexUsageAuth {
	accessToken: string;
	chatgptAccountId: string;
	chatgptPlanType?: string;
}

type Launch = (directory: string) => ChildProcessWithoutNullStreams;

/** Metadata-only app-server connection. No threads, prompts, or user config are loaded. */
export async function readCodexRateLimits(
	auth: CodexUsageAuth,
	signal: AbortSignal,
	launch: Launch = (directory) => {
		const standalone = join(homedir(), ".local", "bin", process.platform === "win32" ? "codex.exe" : "codex");
		return spawn(
			process.env.RELAY_CODEX_PATH || (existsSync(standalone) ? standalone : "codex"),
			["app-server", "--listen", "stdio://"],
			{
				cwd: directory,
				env: { ...process.env, CODEX_HOME: directory, OPENAI_API_KEY: undefined, OPENAI_BASE_URL: undefined },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	},
): Promise<unknown> {
	signal.throwIfAborted();
	const directory = await mkdtemp(join(tmpdir(), "relay-usage-"));
	let child: ChildProcessWithoutNullStreams | undefined;
	let stop: (() => void) | undefined;
	let closed: Promise<void> | undefined;
	try {
		child = launch(directory);
		const connection = child;
		closed = new Promise<void>((resolve) => connection.once("close", () => resolve()));
		return await new Promise<unknown>((resolve, reject) => {
			let settled = false;
			let buffer = "";
			let expected = 1;
			const finish = (error?: Error, value?: unknown) => {
				if (settled) return;
				settled = true;
				if (error) reject(error);
				else resolve(value);
			};
			const send = (message: unknown) => connection.stdin.write(`${JSON.stringify(message)}\n`);
			stop = () => finish(new Error("Usage request timed out"));
			signal.addEventListener("abort", stop, { once: true });
			connection.on("error", () =>
				finish(new Error("Codex CLI unavailable. Install Codex or set RELAY_CODEX_PATH.")),
			);
			connection.on("close", () => finish(new Error("Codex usage service exited")));
			connection.stdin.on("error", () => finish(new Error("Codex usage connection closed")));
			if (signal.aborted) {
				stop();
				return;
			}
			connection.stderr.resume(); // Never forward auth-related process output to the renderer.
			connection.stdout.setEncoding("utf8");
			connection.stdout.on("data", (chunk: string) => {
				if (settled) return;
				buffer += chunk;
				if (buffer.length > 2 * 1024 * 1024) {
					finish(new Error("Codex usage response too large"));
					return;
				}
				let newline = buffer.indexOf("\n");
				while (newline >= 0 && !settled) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					try {
						const message = JSON.parse(line) as {
							id?: number | string;
							method?: string;
							result?: unknown;
							error?: unknown;
						};
						if (message.method && message.id !== undefined) {
							// Pi owns refresh. A revoked token must not cause an interactive sign-in here.
							send({
								id: message.id,
								error: { code: -32601, message: "Refresh usage after reconnecting the account" },
							});
						} else if (message.id === expected) {
							if (message.error) {
								finish(new Error("Codex usage unavailable. Refresh or reconnect the account."));
								return;
							}
							if (expected === 1) {
								expected = 2;
								send({ method: "initialized" });
								send({ id: 2, method: "account/login/start", params: { type: "chatgptAuthTokens", ...auth } });
							} else if (expected === 2) {
								expected = 3;
								send({ id: 3, method: "account/rateLimits/read" });
							} else finish(undefined, message.result);
						}
					} catch {
						finish(new Error("Invalid Codex usage response"));
					}
					newline = buffer.indexOf("\n");
				}
			});
			send({
				id: 1,
				method: "initialize",
				params: { clientInfo: { name: "relay_usage", version: "0.0.3" }, capabilities: { experimentalApi: true } },
			});
		});
	} finally {
		if (stop) signal.removeEventListener("abort", stop);
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
		await closed;
		await rm(directory, { recursive: true, force: true });
	}
}
