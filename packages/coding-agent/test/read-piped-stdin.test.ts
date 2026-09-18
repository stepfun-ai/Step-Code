import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { readPipedStdin } from "../src/main.ts";

const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");

afterEach(() => {
	if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
});

// Drive readPipedStdin against a fake piped stdin (a PassThrough has no isTTY,
// so readPipedStdin treats it as a pipe). Data is buffered before the call and
// flushed once readPipedStdin attaches its listeners and resumes the stream.
async function readFrom(input: string): Promise<string | undefined> {
	const fake = new PassThrough();
	Object.defineProperty(process, "stdin", { value: fake, configurable: true });
	fake.write(input);
	fake.end();
	return readPipedStdin();
}

describe("readPipedStdin", () => {
	// Feedback: piped stdin used to be trimmed (`data.trim() || undefined`), so
	// leading/trailing whitespace and the trailing newline were lost. It must now
	// be preserved verbatim.
	test("preserves leading/trailing whitespace and the trailing newline verbatim", async () => {
		expect(await readFrom("  STDIN_PART  \n")).toBe("  STDIN_PART  \n");
	});

	test("still treats whitespace-only input as absent", async () => {
		expect(await readFrom("   \n")).toBeUndefined();
	});

	test("returns non-whitespace content unchanged", async () => {
		expect(await readFrom("STDIN")).toBe("STDIN");
	});
});
