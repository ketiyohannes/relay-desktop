import type { ChildProcess } from "node:child_process";
import { setTimeout } from "node:timers/promises";

/** Supervised POSIX groups only. Detached tools and remote servers require separate fencing. */
export async function stopProcessGroup(child: ChildProcess, exited: Promise<void>): Promise<"settled" | "unknown"> {
	if (!child.pid) {
		await exited;
		return "settled"; // Spawn failure: no runtime could execute.
	}
	if (process.platform === "win32") {
		child.kill("SIGTERM");
		// A leader's exit does not prove its descendants stopped on Windows.
		return "unknown";
	}
	const pid = child.pid;
	const absent = () => {
		try {
			process.kill(-pid, 0);
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH";
		}
	};
	let closed = false;
	void exited.then(() => {
		closed = true;
	});
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		try {
			process.kill(-pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") return "unknown";
		}
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline) {
			if (closed && absent()) return "settled";
			await setTimeout(25);
		}
	}
	return closed && absent() ? "settled" : "unknown";
}
