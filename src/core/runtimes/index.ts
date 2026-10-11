import { ClaudeAdapter } from "./claude/adapter.ts";
import { CodexAdapter } from "./codex/adapter.ts";
import { PiAdapter } from "./pi/adapter.ts";
import type { RuntimeAdapter } from "./types.ts";

export function nativeAdapters(): RuntimeAdapter[] {
	return [new CodexAdapter(), new ClaudeAdapter(), new PiAdapter()];
}
