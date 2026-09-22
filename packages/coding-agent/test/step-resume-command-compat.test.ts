import { describe, expect, test } from "vitest";
import { translateStepCommandArgs } from "../src/step/command-compat.ts";

// Feedback issue-5946124f7596cd2e: `step resume abc123` exited 1 with
// "Error: --session-id cannot be combined with --resume" because the compat
// layer emitted both flags at once.
describe("translateStepCommandArgs: resume", () => {
	const translate = (argv: string[]): string[] | undefined => translateStepCommandArgs(argv)?.args;

	test("bare `step resume` opens the interactive picker", () => {
		expect(translate(["resume"])).toEqual(["--resume"]);
	});

	test("`step resume <id>` selects that session without --resume", () => {
		expect(translate(["resume", "abc123"])).toEqual(["--session", "abc123"]);
	});

	test("never emits --session-id together with --resume", () => {
		const args = translate(["resume", "abc123"]) ?? [];
		expect(args).not.toContain("--session-id");
		expect(args).not.toContain("--resume");
	});

	test("keeps trailing flags after the session id", () => {
		expect(translate(["resume", "abc123", "--model", "step-3"])).toEqual([
			"--session",
			"abc123",
			"--model",
			"step-3",
		]);
	});

	test("keeps leading flags when no session id is given", () => {
		expect(translate(["resume", "--debug"])).toEqual(["--resume", "--debug"]);
	});

	test("never mistakes a flag value for the session id", () => {
		expect(translate(["resume", "--model", "step-3"])).toEqual(["--resume", "--model", "step-3"]);
	});

	test("preserves a repeated value that matches the session id", () => {
		expect(translate(["resume", "abc123", "--name", "abc123"])).toEqual(["--session", "abc123", "--name", "abc123"]);
	});

	test("leaves non-resume invocations alone", () => {
		expect(translateStepCommandArgs(["--help"])).toBeUndefined();
	});
});
