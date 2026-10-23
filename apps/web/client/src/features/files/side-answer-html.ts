import { renderMarkdown } from "../../lib/markdown";

/**
 * Markdown HTML for a `/btw` answer.
 *
 * The model answers in prose, so the rail renders it the way a reply is
 * rendered. Showing the source would make a side answer read worse than the
 * conversation it is deliberately kept out of.
 */
export function sideAnswerHtml(text: string, labels: { code: string; copy: string; table: string }): string {
	return renderMarkdown(text, labels);
}
