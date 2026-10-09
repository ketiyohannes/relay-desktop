import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "pi-sdk";

export { getAgentDir };
export function expandTildePath(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
