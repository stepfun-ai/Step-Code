/**
 * Rebuilds the streaming assistant message from the host's shortened
 * `message_update` frames (`src/sse-writer.ts`).
 *
 * A frame carries the message's content blocks, but a text or thinking block
 * that only grew since the previous frame holds just the appended tail plus
 * `appendedTo`, the length it extends; a tool call lists its grown top-level
 * string arguments in `appendedArguments` the same way. One assembler belongs
 * to one stream connection: the host's memory of what it sent is per
 * connection too, and both start over at a message boundary or when the
 * message's timestamp changes.
 */

type Block = Record<string, unknown>;

function isBlock(value: unknown): value is Block {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** `previous[field]` cut to `length` and extended by `tail`; the tail alone when there is nothing to extend. */
function extended(previous: unknown, length: number, tail: unknown): string {
	const head = typeof previous === "string" ? previous.slice(0, length) : "";
	return head + (typeof tail === "string" ? tail : "");
}

function rebuildBlock(block: unknown, previous: unknown): unknown {
	if (!isBlock(block)) return block;
	const before = isBlock(previous) && previous.type === block.type ? previous : undefined;
	const { appendedTo, appendedArguments, ...rest } = block;
	if (typeof appendedTo === "number") {
		const field = block.type === "thinking" ? "thinking" : "text";
		return { ...rest, [field]: extended(before?.[field], appendedTo, block[field]) };
	}
	if (isBlock(appendedArguments) && isBlock(block.arguments)) {
		const previousArguments = isBlock(before?.arguments) ? before.arguments : {};
		const args: Block = { ...block.arguments };
		for (const [key, length] of Object.entries(appendedArguments)) {
			if (typeof length === "number") args[key] = extended(previousArguments[key], length, args[key]);
		}
		return { ...rest, arguments: args };
	}
	return appendedArguments === undefined ? block : rest;
}

export class LiveMessageAssembler {
	private timestamp: unknown;
	private blocks: readonly unknown[] = [];

	/** Forget the message: the next frame starts a new one (a boundary, or a new connection). */
	reset(): void {
		this.timestamp = undefined;
		this.blocks = [];
	}

	/** The full content of a frame's message; anything that is not a block list passes through. */
	apply(message: { readonly timestamp?: unknown; readonly content?: unknown } | undefined): unknown {
		const content = message?.content;
		if (!Array.isArray(content)) return content;
		if (message?.timestamp !== this.timestamp) {
			this.timestamp = message?.timestamp;
			this.blocks = [];
		}
		const previous = this.blocks;
		const full = content.map((block, index) => rebuildBlock(block, previous[index]));
		this.blocks = full;
		return full;
	}
}
