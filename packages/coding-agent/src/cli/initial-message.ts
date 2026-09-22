import type { ImageContent } from "@step-harness/providers";
import type { Args } from "./args.ts";

export interface InitialMessageInput {
	parsed: Args;
	fileText?: string;
	fileImages?: ImageContent[];
	stdinContent?: string;
}

export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: ImageContent[];
}

/**
 * Combine stdin content, @file text, and the first CLI message into a single
 * initial prompt for non-interactive mode.
 */
export function buildInitialMessage({
	parsed,
	fileText,
	fileImages,
	stdinContent,
}: InitialMessageInput): InitialMessageResult {
	const parts: string[] = [];
	if (stdinContent !== undefined) {
		parts.push(stdinContent);
	}
	if (fileText) {
		parts.push(fileText);
	}

	if (parsed.messages.length > 0) {
		parts.push(parsed.messages[0]);
		parsed.messages.shift();
	}

	// Join with a single newline between parts so piped stdin, @file text, and the
	// first CLI message stay distinct instead of being concatenated. Parts that
	// already end in a newline (an @file block always does) contribute their own
	// separator, so only insert one when the running text does not already end in
	// one — avoiding a spurious blank line at those boundaries.
	let initialMessage = "";
	for (const part of parts) {
		if (initialMessage.length > 0 && !initialMessage.endsWith("\n")) {
			initialMessage += "\n";
		}
		initialMessage += part;
	}

	return {
		initialMessage: initialMessage.length > 0 ? initialMessage : undefined,
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
	};
}
