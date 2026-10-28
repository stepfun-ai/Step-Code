import type { MarkdownTransformContext, MarkdownTransformer } from "@step-harness/coding-agent";

export function createMarkdownTransform(
	messageType: MarkdownTransformContext["messageType"],
	isStreaming: boolean,
	transformers: readonly MarkdownTransformer[],
): (markdown: string, availableWidth: number) => string {
	return (markdown, availableWidth) =>
		applyMarkdownTransformers(markdown, { messageType, isStreaming, availableWidth }, transformers);
}

/**
 * Transform for a component that outlives a single frame.
 *
 * A reused `Markdown` instance keeps the transform it was constructed with, so the
 * streaming state has to be read at call time: the final frame of a reply renders
 * in "not streaming" mode, and Mermaid warnings only appear then.
 */
export function createLiveMarkdownTransform(
	messageType: MarkdownTransformContext["messageType"],
	readIsStreaming: () => boolean,
	readTransformers: () => readonly MarkdownTransformer[],
): (markdown: string, availableWidth: number) => string {
	return (markdown, availableWidth) =>
		applyMarkdownTransformers(
			markdown,
			{ messageType, isStreaming: readIsStreaming(), availableWidth },
			readTransformers(),
		);
}

function applyMarkdownTransformers(
	markdown: string,
	context: MarkdownTransformContext,
	transformers: readonly MarkdownTransformer[],
): string {
	let transformedMarkdown = markdown;
	for (const transformer of transformers) {
		try {
			const transformed = transformer(transformedMarkdown, context);
			if (typeof transformed === "string") {
				transformedMarkdown = transformed;
			}
		} catch {
			// Keep the current Markdown and continue with the next transformer.
		}
	}
	return transformedMarkdown;
}
