import type { DesktopAction } from "../desktop/types.ts";

export interface HistoryGroup {
	id: string;
	text: string;
	action?: DesktopAction;
	events: DesktopAction[];
}

export interface ProjectHistory {
	groups: HistoryGroup[];
	truncated: boolean;
	message?: string;
}

export interface SnapshotView {
	files: string[];
	changed: string[];
	path?: string;
	before?: string;
	after?: string;
	diff?: string;
	/** Origin snapshot for each line of the after version. */
	origins?: string[];
	fileOrders?: Record<string, number[]>;
}
