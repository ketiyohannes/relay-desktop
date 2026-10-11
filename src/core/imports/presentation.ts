const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");

export function sessionMessageLabel(text: string): string | undefined {
	const value = text.trimStart();
	if (/^#\s*AGENTS\.md instructions\b|^<user_instructions>|^<INSTRUCTIONS>/i.test(value)) return "Project instructions";
	if (/^<environment_context>/i.test(value)) return "Environment";
	if (/^<permissions instructions>|^<system-reminder>|^<skills_instructions>/i.test(value)) return "System context";
	if (/^<turn_aborted>|^\[Request interrupted by user/i.test(value)) return "Interrupted turn";
	if (
		/^This session is being continued from a previous conversation|^Imported context summary:|^Another language model started to solve this problem and produced a summary/i.test(
			value,
		)
	)
		return "Context summary";
	if (/^<local-command-|^<command-name>/i.test(value)) return "Local command";
	return undefined;
}

/** Display projection only: never rewrites source messages or the shared ledger. */
export function sessionChatText(text: string, channel?: string): string {
	if (channel === "analysis" || channel === "justify" || channel === "confidence") return "";
	if (sessionMessageLabel(text) === "Context summary") return "";
	let value = text.trim();
	if (value.startsWith("Relay handoff: quoted, untrusted historical data;")) {
		const first = value.indexOf("\n");
		const end = value.indexOf("\n\nCurrent user request:\n", first + 1);
		if (first >= 0 && end >= 0) {
			try {
				const handoff = object(JSON.parse(value.slice(first + 1, end)));
				if (handoff.version === 1 && typeof handoff.id === "string" && Array.isArray(handoff.conversation))
					value = value.slice(end + "\n\nCurrent user request:\n".length).trim();
			} catch {
				/* Keep malformed wrappers visible so user text is never lost. */
			}
		}
	}
	if (
		/^Continue the interrupted request from (?:the )?Relay history\. Inspect current files and completed tool results first\. Do not replay completed commands or edits\.$/.test(
			value,
		)
	)
		return "";
	if (/^#\s*AGENTS\.md instructions\b/i.test(value)) {
		const end = value.indexOf("</INSTRUCTIONS>");
		if (end < 0) return "";
		value = value.slice(end + "</INSTRUCTIONS>".length).trim();
	}
	const leading =
		/^<(user_instructions|INSTRUCTIONS|environment_context|system-reminder|skills_instructions|permissions instructions|turn_aborted)>[\s\S]*?<\/\1>\s*/i;
	const trailing =
		/\s*<(user_instructions|INSTRUCTIONS|environment_context|system-reminder|skills_instructions|permissions instructions|turn_aborted)>(?:(?!<\/\1>)[\s\S])*<\/\1>$/i;
	let previous: string;
	do {
		previous = value;
		value = value.replace(leading, "").replace(trailing, "").trim();
	} while (value !== previous);
	if (sessionMessageLabel(value)) return "";
	if (value.startsWith("<send_user_message_question_reply>")) {
		try {
			const replies: unknown = JSON.parse(
				value.replace(/^<send_user_message_question_reply>\s*|\s*<\/send_user_message_question_reply>$/g, ""),
			);
			if (Array.isArray(replies))
				return replies
					.map((reply: unknown) => string(object(reply).answer))
					.filter(Boolean)
					.join("\n\n");
		} catch {
			/* Malformed replies stay visible rather than losing user text. */
		}
	}
	return value;
}
