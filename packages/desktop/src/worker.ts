import { DesktopRuntime } from "../../coding-agent/src/desktop/runtime.ts";
import type { DesktopCommand } from "../../coding-agent/src/desktop/types.ts";

const approvals = new Map<string, (allowed: boolean) => void>();
let allowedRun = false;
const directory = process.argv[2];
if (!directory || !process.send) throw new Error("Desktop worker requires an IPC channel and data directory");
const runtime = new DesktopRuntime(directory, {
	login: (login) => process.send?.({ type: "login", login }),
	state: (state) => process.send?.({ type: "state", state }),
	permission: (tool, input) =>
		allowedRun
			? Promise.resolve(true)
			: new Promise<boolean>((resolve) => {
					const id = crypto.randomUUID();
					const timer = setTimeout(() => {
						approvals.delete(id);
						process.send?.({ type: "permission_closed", id });
						resolve(false);
					}, 120000);
					approvals.set(id, (allowed) => {
						clearTimeout(timer);
						process.send?.({ type: "permission_closed", id });
						resolve(allowed);
					});
					process.send?.({ type: "permission", id, tool, input });
				}),
});
const ready = runtime.initialize();
process.on("message", (message: { id: string; command?: DesktopCommand; allowed?: boolean; allowRun?: boolean }) => {
	if (message.allowed !== undefined) {
		if (approvals.has(message.id) && message.allowed && message.allowRun) allowedRun = true;
		approvals.get(message.id)?.(message.allowed);
		approvals.delete(message.id);
		return;
	}
	if (!message.command) return;
	if (["prompt", "review_snapshot", "cancel", "select_account"].includes(message.command.type)) allowedRun = false;
	if (
		message.command.type === "cancel" ||
		(message.command.type === "select_account" &&
			runtime.store.state.busySession === message.command.sessionId &&
			runtime.store.session(message.command.sessionId).accountId !== message.command.accountId)
	) {
		for (const approval of approvals.values()) approval(false);
		approvals.clear();
	}
	void ready
		.then(() => runtime.command(message.command!))
		.then(
			(result) => process.send?.({ type: "response", id: message.id, result }),
			(error: unknown) =>
				process.send?.({
					type: "response",
					id: message.id,
					error: error instanceof Error ? error.message : String(error),
				}),
		);
});
let stopping = false;
const stop = () => {
	if (stopping) return;
	stopping = true;
	void runtime.command({ type: "cancel" });
	void runtime.login.cancel().finally(() => process.exit(0));
};
process.on("disconnect", stop);
process.on("SIGTERM", stop);
