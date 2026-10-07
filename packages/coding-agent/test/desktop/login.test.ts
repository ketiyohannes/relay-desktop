import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeLoginUrl, DesktopLoginManager, type LoginProvider } from "../../src/desktop/login.ts";
import type { DesktopAccount, DesktopLogin } from "../../src/desktop/types.ts";

const directories: string[] = [];
const managers: DesktopLoginManager[] = [];
afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.cancel()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture(provider: LoginProvider, save?: (account: DesktopAccount) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "relay-login-test-"));
	directories.push(directory);
	const events: DesktopLogin[] = [];
	const accounts: DesktopAccount[] = [];
	const manager = new DesktopLoginManager(
		directory,
		(event) => events.push(event),
		save ??
			(async (account) => {
				accounts.push(account);
			}),
		provider,
	);
	managers.push(manager);
	return { directory, events, accounts, manager };
}
describe("desktop sign-in", () => {
	it("saves separate authenticated profiles without sending credentials to the renderer", async () => {
		const f = await fixture(async (_provider, directory, interaction) => {
			await writeFile(join(directory, "auth.json"), '{"access":"secret-token"}', { mode: 0o600 });
			interaction.notify({
				type: "device_code",
				userCode: "ABCD",
				verificationUri: "https://auth.openai.com/device",
			});
			return "model";
		});
		f.manager.start("codex", "First");
		await expect.poll(() => f.events.at(-1)?.status).toBe("success");
		f.manager.start("claude", "Second");
		await expect.poll(() => f.accounts.length).toBe(2);
		expect(f.accounts[0].configDir).not.toBe(f.accounts[1].configDir);
		expect(f.accounts[0]).toMatchObject({ engine: "pi", provider: "openai-codex", credentialSource: "pi" });
		expect(f.accounts[1].engine).toBe("claude");
		expect(await readFile(join(f.accounts[0].configDir, "auth.json"), "utf8")).toContain("secret-token");
		expect(JSON.stringify(f.events)).not.toContain("secret-token");
	});
	it("rejects invalid or stale prompt responses and cancels with no saved account", async () => {
		const f = await fixture(async (_provider, _directory, interaction) => {
			await interaction.prompt({
				type: "select",
				message: "Method",
				options: [{ id: "browser", label: "Browser" }],
			});
			return "model";
		});
		f.manager.start("codex", "Cancelled");
		await expect.poll(() => f.events.at(-1)?.prompt?.id).toBeTruthy();
		const id = f.events.at(-1)!.prompt!.id;
		expect(() => f.manager.reply(id, "invalid")).toThrow("Invalid");
		expect(() => f.manager.start("claude", "Other")).toThrow("Cancel");
		await f.manager.cancel();
		expect(f.events.at(-1)?.status).toBe("cancelled");
		expect(f.accounts).toEqual([]);
		expect(await readdir(join(f.directory, "accounts"))).toEqual([]);
		expect(() => f.manager.reply(id, "browser")).toThrow("expired");
	});
	it("clears a manual prompt when the browser callback wins", async () => {
		const f = await fixture(async (_provider, _directory, interaction) => {
			const abort = new AbortController();
			const input = interaction.prompt({ type: "manual_code", message: "Code", signal: abort.signal });
			abort.abort();
			await expect(input).rejects.toThrow("cancelled");
			return "model";
		});
		f.manager.start("codex", "Browser");
		await expect.poll(() => f.events.at(-1)?.status).toBe("success");
		expect(f.events.at(-1)?.prompt).toBeUndefined();
	});
	it("answers prompts and never echoes manual authorization codes", async () => {
		const f = await fixture(async (_provider, _directory, interaction) => {
			expect(await interaction.prompt({ type: "manual_code", message: "Paste redirect" })).toBe("secret-code");
			return "model";
		});
		f.manager.start("codex", "Account");
		await expect.poll(() => f.events.at(-1)?.prompt?.id).toBeTruthy();
		f.manager.reply(f.events.at(-1)!.prompt!.id, "secret-code");
		await expect.poll(() => f.events.at(-1)?.status).toBe("success");
		expect(JSON.stringify(f.events)).not.toContain("secret-code");
	});
	it("cleans failed profiles and supports retry without exposing provider error secrets", async () => {
		let attempts = 0;
		const f = await fixture(async () => {
			if (attempts++ === 0) throw new Error("secret-token");
			return "model";
		});
		f.manager.start("claude", "Retry");
		await expect.poll(() => f.events.at(-1)?.status).toBe("error");
		expect(await readdir(join(f.directory, "accounts"))).toEqual([]);
		expect(JSON.stringify(f.events)).not.toContain("secret-token");
		f.manager.start("claude", "Retry");
		await expect.poll(() => f.events.at(-1)?.status).toBe("success");
	});
	it("does not retain credentials when saving account metadata fails", async () => {
		const f = await fixture(
			async () => "model",
			async () => {
				throw new Error("Disk full");
			},
		);
		f.manager.start("codex", "Failed save");
		await expect.poll(() => f.events.at(-1)?.status).toBe("error");
		expect(await readdir(join(f.directory, "accounts"))).toEqual([]);
	});
	it("only extracts provider authorization links from CLI output", () => {
		expect(claudeLoginUrl("Open https://claude.ai/oauth/authorize?state=example\n")).toContain("claude.ai/oauth");
		expect(claudeLoginUrl("\x1b]8;;https://claude.com/oauth/authorize?state=example\x1b\\Open browser")).toContain(
			"claude.com/oauth",
		);
		expect(claudeLoginUrl("https://attacker.test/oauth?token=secret")).toBeUndefined();
		expect(claudeLoginUrl("https://user:secret@claude.ai/oauth/authorize")).toBeUndefined();
		expect(claudeLoginUrl("access-token: secret")).toBeUndefined();
	});
});
