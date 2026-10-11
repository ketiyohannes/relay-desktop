import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateSelection } from "../service/protocol.ts";
import type { WorkerProfile } from "./types.ts";

export async function loadWorkers(directory: string): Promise<WorkerProfile[]> {
	try {
		const workers = JSON.parse(await readFile(join(directory, "workers.json"), "utf8")) as WorkerProfile[];
		if (!Array.isArray(workers)) throw new Error("workers.json must contain an array");
		for (const worker of workers) {
			if (
				typeof worker.id !== "string" ||
				typeof worker.description !== "string" ||
				typeof worker.resource !== "string" ||
				!worker.resource ||
				validateSelection(worker.selection).backend === "pi"
			)
				throw new Error("Invalid native worker profile");
		}
		if (new Set(workers.map((worker) => worker.id)).size !== workers.length)
			throw new Error("Duplicate worker profile ID");
		return workers.map((worker) => ({
			...worker,
			selection: validateSelection(worker.selection) as WorkerProfile["selection"],
		}));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return [];
	}
}
