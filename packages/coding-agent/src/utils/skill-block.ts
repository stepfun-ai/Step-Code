/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(
		/^<skill name="([^"]+)" location="([^"]+)"( encoding="xml")?>\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
	);
	if (!match) return null;
	const decode = (value: string) =>
		match[3]
			? value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
			: value;
	return {
		name: decode(match[1]),
		location: decode(match[2]),
		content: decode(match[4]),
		userMessage: match[5]?.trim() || undefined,
	};
}
