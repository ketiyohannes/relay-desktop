import type { projectEvents } from "../sessions/desktop-projection.ts";

import type { DesktopAction, DesktopSession, DesktopState, DesktopUpdate } from "./types.ts";

interface UpdatesHost {
	ready(): boolean;
	running(): boolean;
	externalBusy(): string | undefined;
	state(): DesktopState;
	publicState(actions?: Set<DesktopAction>): DesktopState;
	save(ids: readonly string[]): Promise<void>;
	emit(state: DesktopState): void;
	update?: (update: DesktopUpdate) => void;
}

export class DesktopUpdates {
	private readonly host: UpdatesHost;
	private readonly streamActions = new Map<DesktopSession, Set<DesktopAction>>();
	private streamTimer?: ReturnType<typeof setTimeout>;
	private persistTimer?: ReturnType<typeof setTimeout>;
	private readonly dirtySessions = new Set<string>();
	constructor(host: UpdatesHost) {
		this.host = host;
	}
	clearPersistence(): void {
		clearTimeout(this.persistTimer);
		this.persistTimer = undefined;
		this.dirtySessions.clear();
	}
	streamEvent(
		session: DesktopSession,
		event: Parameters<typeof projectEvents>[1][number],
		previousLength: number,
	): void {
		const data = event.data;
		const changed = session.actions.slice(previousLength);
		if (data.type === "runtime") {
			const runtime = data.event;
			if ("id" in runtime) {
				const action = session.actions.find(
					(action) =>
						action.id === `${runtime.type === "text" ? "native" : "tool"}:${data.nativeRecordId}:${runtime.id}`,
				);
				if (action) changed.push(action);
			}
			if (runtime.type === "done")
				changed.push(...session.actions.filter((action) => action.id.startsWith(`native:${data.nativeRecordId}:`)));
		}
		if (data.type === "note" || data.type === "task") {
			const action = session.actions.find(
				(action) => action.id === (data.type === "note" ? data.note.id : `task:${data.task.id}`),
			);
			if (action) changed.push(action);
		}
		this.stream(session, changed);
	}
	stream(session: DesktopSession, actions: DesktopAction[]): void {
		const pending = this.streamActions.get(session) ?? new Set<DesktopAction>();
		for (const action of actions) pending.add(action);
		this.streamActions.set(session, pending);
		this.dirtySessions.add(session.id);
		this.streamTimer ??= setTimeout(() => this.flushStream(), 50);
		this.persistTimer ??= setTimeout(() => {
			this.persistTimer = undefined;
			const ids = [...this.dirtySessions];
			this.dirtySessions.clear();
			void this.host
				.save(ids)
				.catch((error: unknown) => process.stderr.write(`Relay projection save failed: ${String(error)}\n`));
		}, 1000);
	}
	flushStream(): void {
		clearTimeout(this.streamTimer);
		this.streamTimer = undefined;
		if (!this.host.ready() || !this.streamActions.size) return;
		if (!this.host.running()) this.host.state().busySession = this.host.externalBusy();
		if (this.host.update) {
			const actions = new Set([...this.streamActions.values()].flatMap((actions) => [...actions]));
			const state = this.host.publicState(actions);
			const ids = new Set([...this.streamActions.keys()].map((session) => session.id));
			for (const session of state.sessions) {
				if (!ids.has(session.id)) continue;
				this.host.update({ session, busySession: state.busySession });
			}
		} else this.host.emit(this.host.publicState());
		this.streamActions.clear();
	}
}
