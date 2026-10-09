import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function applicationDirectory(): string {
	if (process.env.RELAY_APP_DIR) return process.env.RELAY_APP_DIR;
	const base =
		process.env.RELAY_DATA_DIR ||
		(process.platform === "darwin"
			? join(homedir(), "Library", "Application Support", "Relay")
			: process.platform === "win32"
				? join(process.env.APPDATA || homedir(), "Relay")
				: join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "Relay"));
	return join(base, "sessions", "app");
}
export function socketPath(directory: string): string {
	const hash = createHash("sha256").update(directory).digest("hex").slice(0, 24);
	return process.platform === "win32"
		? `\\\\.\\pipe\\relay-${hash}`
		: join(tmpdir(), `relay-${process.getuid?.() ?? "user"}-${hash}.sock`);
}
