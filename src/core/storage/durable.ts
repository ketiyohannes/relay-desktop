import { open } from "node:fs/promises";

/** POSIX directory sync makes newly created or renamed records durable. */
export async function syncDirectory(path: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function writePrivateFile(path: string, data: string): Promise<void> {
	const handle = await open(path, "w", 0o600);
	try {
		await handle.writeFile(data);
		await handle.sync();
	} finally {
		await handle.close();
	}
}
