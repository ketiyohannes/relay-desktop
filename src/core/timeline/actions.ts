import type { DesktopAction, DesktopSession } from "../desktop/types.ts";
import { projectHistory } from "./history.ts";
import { DesktopTimeline } from "./snapshots.ts";

export async function snapshotAction(session: DesktopSession, id: string): Promise<DesktopAction | undefined> {
	const local = session.actions.find((action) => action.id === id);
	if (local || !id.startsWith("history:")) return local;
	const history = await projectHistory(new DesktopTimeline(session.project, session.id));
	return history.groups
		.flatMap((group) => [...(group.action ? [group.action] : []), ...group.events])
		.find((action) => action.id === id);
}
