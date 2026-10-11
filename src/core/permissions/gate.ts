import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RuntimeEvent } from "../runtimes/types.ts";
import type { PermissionMode } from "./types.ts";

const reads = new Set(["read", "grep", "find", "ls", "Read", "Grep", "Glob"]);
const edits = new Set(["write", "edit", "Write", "Edit", "NotebookEdit"]);

export class PermissionGate {
	private readonly pending = new Map<string, (allowed: boolean) => void>();
	private cancelled = false;
	async check(
		mode: PermissionMode,
		workspace: string,
		tool: string,
		input: unknown,
		emit: (event: RuntimeEvent) => Promise<void>,
		readPaths: string[] = [],
	): Promise<boolean> {
		if (this.cancelled) return false;
		if (mode === "read-only") {
			if (!reads.has(tool)) return false;
			const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
			if (tool === "Glob" || tool === "find") {
				if (
					typeof args.pattern !== "string" ||
					isAbsolute(args.pattern) ||
					/^[A-Za-z]:|^\\\\|^~[/\\]|(?:^|[,({])[/\\]|(?:^|[/\\,({])\.\.(?:$|[/\\,})])/.test(args.pattern)
				)
					return false;
			}
			const path =
				typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : ".";
			try {
				const canonical = await realpath(resolve(workspace, path));
				for (const allowed of tool === "Read" || tool === "read" ? readPaths : [])
					if (canonical === (await realpath(allowed).catch(() => undefined))) return true;
				const local = relative(await realpath(workspace), canonical);
				if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) return false;
				if (tool === "Glob" || tool === "find") {
					// Resolve literal directories before the first wildcard so a symlink
					// cannot redirect a relative pattern outside its approved search root.
					const components = (args.pattern as string).split(/[\\/]/);
					const wildcard = components.findIndex((part) => /[*?[{(]/.test(part));
					const prefix = components.slice(0, wildcard < 0 ? components.length : wildcard).join(sep);
					const target = relative(await realpath(workspace), await realpath(resolve(canonical, prefix)));
					if (target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) return false;
				}
				return true;
			} catch {
				return false;
			}
		}
		if (mode === "full-access") return true;
		if (mode === "auto-approve" && (reads.has(tool) || edits.has(tool))) return true;
		const id = randomUUID();
		let finish!: (allowed: boolean) => void;
		const answer = new Promise<boolean>((resolve) => {
			finish = resolve;
		});
		this.pending.set(id, finish);
		try {
			await emit({ type: "approval", id, tool, input });
			return await answer;
		} finally {
			this.pending.delete(id);
		}
	}
	respond(id: string, allowed: boolean): "sent" | "expired" {
		const finish = this.pending.get(id);
		if (!finish) return "expired";
		this.pending.delete(id);
		finish(allowed && !this.cancelled);
		return "sent";
	}
	cancel(): void {
		this.cancelled = true;
		for (const finish of this.pending.values()) finish(false);
		this.pending.clear();
	}
}
