/**
 * Catalog descriptions are lifted from third-party READMEs and manifests, so a
 * single line may carry HTML badges, license comments, `<div align="center">`
 * wrappers or markdown emphasis. The market shows one plain line per entry and
 * searches it, so normalize before it reaches either.
 *
 * Kept as a plain module (no imports) so the packaging scripts can share it.
 * Full text is preserved: the list truncates visually and reveals the rest on
 * hover, so cutting here would hide content the UI still offers.
 */

/** Markup that would otherwise show up verbatim in a plain-text line. */
const MARKUP = /<[a-zA-Z!/]|<!--|!\[|\[[^\]]*\]\(|&lt;|&gt;|\*\*|`|__/u;

function decodeEntities(value) {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

export function hasDescriptionMarkup(value) {
	return typeof value === "string" && MARKUP.test(value);
}

export function normalizeExtensionDescription(raw) {
	if (typeof raw !== "string" || !raw.trim()) return "";
	const text = decodeEntities(raw)
		// HTML comments (license headers, mcp-name markers) and tags carry no prose.
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<\/?[a-zA-Z][^>]*>/g, " ")
		// Some upstream descriptions were themselves cut mid-tag, leaving `<img src="h`
		// with no closing bracket; an unterminated tag runs to the next `<` or the end.
		.replace(/<[a-zA-Z][^<>]*(?=<|$)/g, " ")
		// Badges are images; a markdown link keeps its label.
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		// Line-leading list and heading markers only: prose may legitimately contain "-".
		.replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
		.replace(/^[ \t]*[-*+][ \t]+/gm, "")
		.replace(/^[ \t]*\d+\.[ \t]+/gm, "")
		.replace(/\|/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	// Anything still carrying angle brackets is markup we failed to understand;
	// reporting nothing lets the caller fall back to a truthful summary.
	return /[<>]/u.test(text) ? "" : text;
}
