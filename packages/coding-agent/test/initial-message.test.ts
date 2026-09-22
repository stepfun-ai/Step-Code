import { describe, expect, test } from "vitest";
import type { Args } from "../src/cli/args.ts";
import { buildInitialMessage } from "../src/cli/initial-message.ts";

function createArgs(messages: string[] = []): Args {
	return {
		messages: [...messages],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};
}

describe("buildInitialMessage", () => {
	test("merges piped stdin with the first CLI message into one prompt", () => {
		const parsed = createArgs(["Summarize the text given"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "README contents\n",
		});

		expect(result.initialMessage).toBe("README contents\nSummarize the text given");
		expect(parsed.messages).toEqual([]);
	});

	test("uses stdin as the initial prompt when no CLI message is present", () => {
		const parsed = createArgs();
		const result = buildInitialMessage({
			parsed,
			stdinContent: "README contents",
		});

		expect(result.initialMessage).toBe("README contents");
		expect(parsed.messages).toEqual([]);
	});

	test("combines stdin, file text, and first CLI message in one prompt", () => {
		const parsed = createArgs(["Explain it", "Second message"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "stdin\n",
			fileText: "file\n",
		});

		expect(result.initialMessage).toBe("stdin\nfile\nExplain it");
		expect(parsed.messages).toEqual(["Second message"]);
	});

	// Feedback: piped stdin without a trailing newline used to be concatenated
	// directly onto the CLI message ("STDIN_PARTCLI_PART"). Parts must stay
	// separated by a newline.
	test("inserts a newline between stdin without a trailing newline and the CLI message", () => {
		const parsed = createArgs(["CLI_PART"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "STDIN_PART",
		});

		expect(result.initialMessage).toBe("STDIN_PART\nCLI_PART");
	});

	// Feedback: stdin original formatting (leading/trailing whitespace) must be
	// preserved, with a single newline before the CLI message. Uses stdin with no
	// trailing newline so it also fails on the old join("") behavior.
	test("preserves stdin whitespace and separates it from the CLI message with one newline", () => {
		const parsed = createArgs(["CLI_PART"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "  STDIN_PART  ",
		});

		expect(result.initialMessage).toBe("  STDIN_PART  \nCLI_PART");
	});

	test("does not add a blank line when a part already ends with a newline", () => {
		const parsed = createArgs(["Explain it"]);
		const result = buildInitialMessage({
			parsed,
			fileText: '<file name="/abs/notes.txt">\nhello\n</file>\n',
		});

		expect(result.initialMessage).toBe('<file name="/abs/notes.txt">\nhello\n</file>\nExplain it');
	});
});
