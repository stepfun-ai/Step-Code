/**
 * Tool-result images are model input the page never draws. A `read_file` of a
 * screenshot keeps its base64 data in the transcript, and every snapshot and
 * stream event used to resend it: in a screenshot-heavy session it was most of
 * each read. The page receives this placeholder instead and fetches one image
 * from `GET /api/v1/sessions/{id}/entries/{entryId}/images/{index}` when it needs it.
 */
export interface OmittedImage {
	readonly type: "image";
	readonly mimeType: string;
	readonly omitted: true;
}

function hasImageData(part: unknown): part is { type: "image"; data: string; mimeType?: unknown } {
	if (!part || typeof part !== "object") return false;
	const record = part as { type?: unknown; data?: unknown };
	return record.type === "image" && typeof record.data === "string";
}

/** `content` with every image's data replaced by an `OmittedImage`; the same value when it has none. */
export function omitImageData(content: unknown): unknown {
	if (!Array.isArray(content) || !content.some(hasImageData)) return content;
	return content.map((part: unknown): unknown =>
		hasImageData(part)
			? ({
					type: "image",
					mimeType: typeof part.mimeType === "string" ? part.mimeType : "",
					omitted: true,
				} satisfies OmittedImage)
			: part,
	);
}

/** A tool result message without its image data; any other message, or a result without images, unchanged. */
export function withoutToolResultImages<T>(message: T): T {
	if (!message || typeof message !== "object") return message;
	const record = message as { role?: unknown; content?: unknown };
	if (record.role !== "toolResult") return message;
	const content = omitImageData(record.content);
	// Wire projection only: the kernel's message object itself is never modified.
	return content === record.content ? message : ({ ...message, content } as T);
}

/** The images of a message's content in order, data included: what the image route serves by index. */
export function messageImages(content: unknown): readonly { readonly data: string; readonly mimeType: string }[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((part: unknown) =>
		hasImageData(part) ? [{ data: part.data, mimeType: typeof part.mimeType === "string" ? part.mimeType : "" }] : [],
	);
}
