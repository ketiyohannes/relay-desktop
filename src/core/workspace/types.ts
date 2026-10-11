export interface DirectoryView {
	path: string;
	parent: string;
	entries: { name: string; path: string; directory: boolean }[];
}

export interface CodeSearchResult {
	matches: { path: string; line: number; side: "before" | "after"; text: string; kind: string }[];
	truncated: boolean;
	skipped: number;
}

export interface EditorFile {
	path: string;
	content: string;
	warning?: string;
}
