/** A file the user attached to a message. `data` is base64. */
export interface WebAttachment {
	readonly name: string;
	readonly mimeType: string;
	readonly data: string;
	readonly kind: "image" | "text";
}

/** Files larger than this are refused rather than ballooning the prompt. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** How much of an oversized text attachment or uploaded file is inlined before truncating. */
export const MAX_INLINED_CHARS = 40_000;

export function classifyAttachment(mimeType: string): "image" | "text" {
	return mimeType.startsWith("image/") ? "image" : "text";
}

/**
 * Cut `value` to `limit` code points.
 *
 * Counting UTF-16 units (`.length`) splits a surrogate pair and can leave half
 * an emoji or a broken multi-byte character at the cut; code points are what
 * the reader sees.
 */
function truncateCodePoints(value: string, limit: number): { head: string; total: number } {
	const codePoints = Array.from(value);
	if (codePoints.length <= limit) return { head: value, total: codePoints.length };
	return { head: codePoints.slice(0, limit).join(""), total: codePoints.length };
}

/**
 * Fold text attachments into the prompt.
 *
 * Images travel separately as real image content, so only text files need
 * inlining. The filename is repeated inside the block because the model
 * otherwise has no way to refer back to the file it was handed.
 *
 * A truncated file says how much arrived, how much there is, and that the
 * remainder was not sent. `… (truncated)` alone left the model aware that
 * something was missing without knowing how much, which invites guesses about
 * content it never received. This path inlines an uploaded copy and has no
 * workspace path to point at — files the host stores say so in `uploads.ts`.
 */
export function withTextAttachments(text: string, attachments: readonly WebAttachment[]): string {
	const texts = attachments.filter((attachment) => attachment.kind === "text");
	if (!texts.length) return text;
	const blocks = texts.map((attachment) => {
		const decoded = Buffer.from(attachment.data, "base64").toString("utf8");
		const { head, total } = truncateCodePoints(decoded, MAX_INLINED_CHARS);
		const body =
			head === decoded
				? decoded
				: `${head}\n[Showing characters 1-${MAX_INLINED_CHARS} of ${total}. The remainder was not included; ask for that part to be attached separately.]`;
		return `[attached file: ${attachment.name}]\n\`\`\`\n${body}\n\`\`\``;
	});
	return [text, ...blocks].filter((part) => part.trim()).join("\n\n");
}
