import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopStore } from "../../../src/core/desktop/store.ts";
import type { DesktopCommand } from "../../../src/core/desktop/types.ts";
import { fakeAccountCatalog } from "./fixtures.ts";
import { type DesktopEngine, DesktopRuntime } from "./offline-runtime.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(engine: DesktopEngine) {
	const root = await mkdtemp(join(await realpath(tmpdir()), "relay-permissions-"));
	roots.push(root);
	const project = join(root, "project");
	await mkdir(project);
	await writeFile(join(project, "source.ts"), "export const value = 1;\n");
	await writeFile(join(root, "outside.ts"), "private\n");
	await symlink(join(root, "outside.ts"), join(project, "linked.ts"));
	const permission = vi.fn(async () => true);
	const runtime = new DesktopRuntime(
		join(root, "relay"),
		{ state: () => {}, permission },
		engine,
		fakeAccountCatalog,
		[],
	);
	await runtime.initialize();
	runtime.store.state.projects.push(project);
	runtime.store.state.accounts.push({
		id: "account",
		name: "Test",
		engine: "claude",
		provider: "",
		model: "sonnet",
		configDir: "",
	});
	await runtime.command({ type: "session", project });
	const session = runtime.store.state.sessions[0];
	return { root, project, runtime, session, permission };
}

it.each(["ask", "auto-approve", "full-access", "read-only"] as const)(
	"enforces and persists %s permissions",
	async (mode) => {
		const results: boolean[] = [];
		let readOnly: boolean | undefined;
		const file = await fixture(async (_session, _account, _prompt, _abort, callbacks) => {
			readOnly = callbacks.readOnly;
			for (const [name, input] of [
				["Read", { file_path: join(file.project, "source.ts") }],
				["Read", { file_path: join(file.project, "linked.ts") }],
				["Edit", { file_path: join(file.project, "source.ts") }],
				["Bash", { command: "pwd" }],
				["UnknownTool", {}],
			] as const)
				results.push(await callbacks.permission(name, input));
		});
		await file.runtime.command({ type: "session_permissions", sessionId: file.session.id, mode });
		await file.runtime.command({ type: "prompt", sessionId: file.session.id, text: "Inspect the code" });
		await expect.poll(() => file.runtime.store.state.busySession).toBeUndefined();
		expect(results).toEqual(mode === "read-only" ? [true, false, false, false, false] : [true, true, true, true, true]);
		expect(readOnly).toBe(mode === "read-only");
		expect(file.permission).toHaveBeenCalledTimes(mode === "ask" ? 5 : mode === "auto-approve" ? 2 : 0);
		const reloaded = new DesktopStore(join(file.root, "relay"));
		await reloaded.load();
		expect(reloaded.session(file.session.id).permissionMode).toBe(mode);
	},
);

it("rejects unknown modes and changes during an active run", async () => {
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const file = await fixture(async () => {
		await pending;
	});
	await expect(
		file.runtime.command({
			type: "session_permissions",
			sessionId: file.session.id,
			mode: "bypass",
		} as unknown as DesktopCommand),
	).rejects.toThrow("Unknown permission mode");
	await file.runtime.command({ type: "prompt", sessionId: file.session.id, text: "Wait" });
	try {
		await expect(
			file.runtime.command({ type: "session_permissions", sessionId: file.session.id, mode: "full-access" }),
		).rejects.toThrow("Stop the current run");
	} finally {
		finish();
		await expect.poll(() => file.runtime.store.state.busySession).toBeUndefined();
	}
});

it.each(["auto-approve", "full-access"] as const)("does not override a native escalation in %s mode", async (mode) => {
	let allowed: boolean | undefined;
	const file = await fixture(async (_session, _account, _prompt, _abort, callbacks) => {
		allowed = await callbacks.permission("Edit", { file_path: "source.ts" }, { sessionId: "worker", turnId: "turn" });
	});
	file.permission.mockResolvedValue(false);
	await file.runtime.command({ type: "session_permissions", sessionId: file.session.id, mode });
	await file.runtime.command({ type: "prompt", sessionId: file.session.id, text: "Inspect" });
	await expect.poll(() => file.runtime.store.state.busySession).toBeUndefined();
	expect(allowed).toBe(false);
	expect(file.permission).toHaveBeenCalledOnce();
});
