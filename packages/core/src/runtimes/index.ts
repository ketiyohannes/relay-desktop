import type { RuntimeAdapter } from "../contracts.ts";
import { ClaudeAdapter } from "./claude/adapter.ts";
import { CodexAdapter } from "./codex/adapter.ts";
import { PiAdapter } from "./pi/adapter.ts";

export function nativeAdapters(): RuntimeAdapter[] {
	return [new CodexAdapter(), new ClaudeAdapter(), new PiAdapter()];
}
