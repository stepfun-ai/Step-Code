import type { ToolResultMessage } from "@step-harness/providers";
import { truncateHead } from "../../tools/truncate.ts";
import { type LiveContextDocument, renderLiveContextIndex } from "./document.ts";

export const LIVE_CONTEXT_READ_MAX_BYTES = 4096;
export const LIVE_CONTEXT_READ_MAX_LINES = 40;

export interface LiveContextReadView {
	kind: "index" | "excerpt";
	content: ToolResultMessage["content"];
}

interface ReadViewInput {
	document: LiveContextDocument;
	mirrorPath: string;
	isMirrorPath: boolean;
	toolName: string;
	args: unknown;
	content: ToolResultMessage["content"];
	isError: boolean;
	truncated?: boolean;
}

/** Limit model-visible self-reads, while ordinary file IO and atomic edits retain their effects. */
export function createLiveContextReadView(input: ReadViewInput): LiveContextReadView | undefined {
	const text = input.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const read = input.isMirrorPath && (input.toolName === "read" || input.toolName === "read_file") && !input.isError;
	const document = input.document;
	const echoed =
		text.includes(
			`[[LIVE_CONTEXT version=${document.version} revision=${document.revision} document=${document.documentId}`,
		) ||
		["CTX_TURN", "CTX_TEXT", "CTX_IMAGE"].some((marker) =>
			text.includes(`[[${marker} document=${document.documentId} `),
		);
	if (!read && !(Buffer.byteLength(text, "utf8") > LIVE_CONTEXT_READ_MAX_BYTES && (input.isMirrorPath || echoed)))
		return undefined;

	const replaceText = (body: string): ToolResultMessage["content"] => {
		let replaced = false;
		return input.content.flatMap<ToolResultMessage["content"][number]>((part) => {
			if (part.type !== "text") return [part];
			if (replaced) return [];
			replaced = true;
			return [{ ...part, text: body }];
		});
	};
	const args = input.args && typeof input.args === "object" ? (input.args as Record<string, unknown>) : {};
	const stepRead = input.toolName === "read_file";
	const offset = (stepRead ? args.start_line : args.offset) ?? 1;
	const limit = stepRead
		? typeof args.end_line === "number" && typeof offset === "number"
			? args.end_line - offset + 1
			: undefined
		: args.limit;
	const truncated = input.truncated || (stepRead && /\n\n\[Output truncated to \d+ characters\.\]$/.test(text));
	if (
		read &&
		!truncated &&
		typeof limit === "number" &&
		Number.isInteger(limit) &&
		limit > 0 &&
		limit <= LIVE_CONTEXT_READ_MAX_LINES &&
		typeof offset === "number" &&
		Number.isInteger(offset) &&
		offset > 0
	) {
		const selected = text.replace(/\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/, "");
		const quoted = selected
			.split("\n")
			.map((line, index) => (stepRead ? `| ${line}` : `L${offset + index} | ${line}`))
			.join("\n");
		const view = `Working-context excerpt (read-only, requested lines ${offset}-${offset + limit - 1}). Use current block IDs for atomic edits; do not copy this view back into the mirror or paginate the whole conversation.\n\n${quoted}`;
		if (Buffer.byteLength(view, "utf8") <= LIVE_CONTEXT_READ_MAX_BYTES)
			return { kind: "excerpt", content: replaceText(view) };
	}

	const note = input.isError
		? `Tool error; large working-context output was limited. ${text.split("\n", 1)[0].slice(0, 256)}\n\n`
		: "";
	const instructions = `Working-context read view: the conversation is already in context, so a whole or oversized mirror read returns this index. For a specific missing fact, search locally or request an explicit range of at most ${LIVE_CONTEXT_READ_MAX_LINES} lines that fits ${LIVE_CONTEXT_READ_MAX_BYTES} bytes. Do not paginate the full mirror. Edit selected block IDs in one atomic local read-modify-write, then wait for the acceptance notice.\n\n`;
	const suffix = "\n[Index view bounded; select a block ID or a specific short evidence range.]";
	const full = note + instructions + renderLiveContextIndex(document, input.mirrorPath);
	const bounded = truncateHead(full, {
		maxBytes: LIVE_CONTEXT_READ_MAX_BYTES - Buffer.byteLength(suffix),
		maxLines: 80,
	});
	return { kind: "index", content: replaceText(bounded.content + (bounded.truncated ? suffix : "")) };
}
