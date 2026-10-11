export function toolLabel(action) {
	const name = action.text.split("\n")[0];
	const labels = {
		exec_command: "Run command",
		Bash: "Run command",
		bash: "Run command",
		write_stdin: "Continue command",
		read: "Read file",
		Read: "Read file",
		write: "Write file",
		Write: "Write file",
		edit: "Edit file",
		Edit: "Edit file",
		apply_patch: "Apply patch",
		grep: "Search text",
		Grep: "Search text",
		Glob: "Find files",
		find: "Find files",
		ls: "List files",
		update_plan: "Update plan",
		exec: "Run JavaScript",
	};
	return labels[name.split(".").at(-1)] || name;
}
