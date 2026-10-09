import { DesktopRuntime } from "../core/desktop/runtime.ts";
import type { DesktopCommand } from "../core/desktop/types.ts";

const approvals = new Map<string, (allowed: boolean) => void>();
const approvalScopes = new Map<string, string>();
let allowedRunScope: string | undefined;
const directory = process.argv[2];
if (!directory || !process.send) throw new Error("Desktop worker requires an IPC channel and data directory");
const runtime = new DesktopRuntime(directory, {
	login: (login) => process.send?.({ type: "login", login }),
	state: (state) => process.send?.({ type: "state", state }),
	update: (update) => process.send?.({ type: "update", update }),
	permission: (tool, input, scope, signal) =>
		scope && allowedRunScope === `${scope.sessionId}:${scope.turnId}`
			? Promise.resolve(true)
			: new Promise<boolean>((resolve) => {
					if (signal?.aborted) {
						resolve(false);
						return;
					}
					const id = crypto.randomUUID();
					if (scope) approvalScopes.set(id, `${scope.sessionId}:${scope.turnId}`);
					const settle = (allowed: boolean) => {
						clearTimeout(timer);
						signal?.removeEventListener("abort", aborted);
						approvals.delete(id);
						approvalScopes.delete(id);
						process.send?.({ type: "permission_closed", id });
						resolve(allowed);
					};
					const aborted = () => settle(false);
					const timer = setTimeout(aborted, 120000);
					approvals.set(id, settle);
					signal?.addEventListener("abort", aborted, { once: true });
					process.send?.({ type: "permission", id, tool, input });
				}),
});
const ready = runtime.initialize();
const refresh = () => {
	void ready
		.then(() => runtime.refreshSessions(false))
		.catch((error: unknown) => {
			process.stderr.write(`Relay session discovery failed: ${String(error)}\n`);
		});
};
refresh();
const discoveryTimer = setInterval(refresh, 60000);
discoveryTimer.unref();
process.on("message", (message: { id: string; command?: DesktopCommand; allowed?: boolean; allowRun?: boolean }) => {
	if (message.allowed !== undefined) {
		if (approvals.has(message.id) && message.allowed && message.allowRun)
			allowedRunScope = approvalScopes.get(message.id);
		approvals.get(message.id)?.(message.allowed);
		approvals.delete(message.id);
		approvalScopes.delete(message.id);
		return;
	}
	if (!message.command) return;
	if (["prompt", "review_snapshot", "cancel", "select_account", "session_permissions"].includes(message.command.type))
		allowedRunScope = undefined;
	if (
		message.command.type === "cancel" ||
		(message.command.type === "select_account" &&
			runtime.store.state.busySession === message.command.sessionId &&
			runtime.store.session(message.command.sessionId).accountId !== message.command.accountId)
	) {
		for (const approval of approvals.values()) approval(false);
		approvals.clear();
		approvalScopes.clear();
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
	clearInterval(discoveryTimer);
	void runtime.command({ type: "cancel" });
	void runtime.login.cancel().finally(() => process.exit(0));
};
process.on("disconnect", stop);
process.on("SIGTERM", stop);
