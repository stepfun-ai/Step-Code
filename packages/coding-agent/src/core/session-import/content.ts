const CONTROL_TAGS = [
	"system-reminder",
	"environment_context",
	"permissions instructions",
	"user_instructions",
	"developer_instructions",
	"turn_aborted",
	"request_id",
	"turn_id",
	"model",
	"command-name",
	"command-message",
	"command-args",
	"local-command-caveat",
	"local-command-stdout",
	"local-command-stderr",
];
const PREFIX = new RegExp(`^\\s*<(${CONTROL_TAGS.join("|")})(?:\\s[^>]*)?>`);

function unwrapUserQuery(value: string): string {
	const start = /^\s*<user_query(?:\s[^>]*)?>/.exec(value);
	if (!start) return value;
	const tokens = /<\/?user_query(?:\s[^>]*)?>/g;
	tokens.lastIndex = start[0].length;
	let depth = 1;
	for (let token = tokens.exec(value); token; token = tokens.exec(value)) {
		depth += token[0].startsWith("</") ? -1 : 1;
		if (depth === 0) {
			if (value.slice(tokens.lastIndex).trim()) return value;
			return value.slice(start[0].length, token.index);
		}
	}
	return value;
}

/** Remove source-host envelopes and unwrap complete user payloads, not fenced examples. */
export function stripImportedUserControls(value: string): { text: string; removed: boolean } {
	let text = value;
	let removed = false;
	for (;;) {
		const first = PREFIX.exec(text);
		if (!first) return { text: unwrapUserQuery(text), removed };
		removed = true;
		const tag = first[1];
		const tokens = new RegExp(`<\\/?${tag}(?:\\s[^>]*)?>`, "g");
		tokens.lastIndex = first[0].length;
		let depth = 1;
		let end = -1;
		for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
			depth += token[0].startsWith("</") ? -1 : 1;
			if (depth === 0) {
				end = tokens.lastIndex;
				break;
			}
		}
		// A partial source envelope is not a trustworthy user prompt.
		if (end < 0) return { text: "", removed };
		text = text.slice(end).trimStart();
	}
}
