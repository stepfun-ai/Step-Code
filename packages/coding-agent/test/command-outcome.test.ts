import { describe, expect, it } from "vitest";
import {
	appendCommandOutputFooter,
	isToolCommandFailure,
	readToolCommandNotice,
	splitCommandOutputFooter,
} from "../src/core/tools/command-outcome.ts";

const footer = (notice: string, status: string) => ({ notice, status });

describe("command output framing", () => {
	const combinations = [
		{ body: "", notice: "", status: "" },
		{ body: "", notice: "", status: "Command aborted" },
		{ body: "output", notice: "", status: "Command exited with code 1" },
		{ body: "output\n", notice: "", status: "Command exited with code 1" },
		{ body: "", notice: "\n\n[Full output: /tmp/a.log]", status: "" },
		{ body: "", notice: "\n\n[Full output: /tmp/a.log]", status: "Command exited with code 1" },
		{ body: "output", notice: "\n\n[Full output: /tmp/a.log]", status: "Command timed out after 1 seconds" },
	];

	it.each(combinations)("round-trips body=%j notice=%j status=%j", ({ body, notice, status }) => {
		const text = appendCommandOutputFooter(body, footer(notice, status));
		const split = splitCommandOutputFooter(text, footer(notice, status));
		expect(split.body).toBe(body);
		expect(split.status).toBe(status);
	});

	it("keeps the text untouched when no footer was declared", () => {
		expect(appendCommandOutputFooter("output", undefined)).toBe("output");
		expect(splitCommandOutputFooter("output", undefined)).toEqual({ body: "output", status: "" });
	});
});

describe("reading a result's declared command outcome", () => {
	const observed = (exitCode: number | null, status: string) => ({
		status,
		exitCode,
		signal: null,
		timedOut: false,
		aborted: false,
	});

	it("reads the top-level execution facts", () => {
		expect(readToolCommandNotice({ execution: observed(3, "exited") })).toBe("Command exited with code 3");
		expect(readToolCommandNotice({ execution: observed(0, "exited") })).toBeUndefined();
		expect(readToolCommandNotice({})).toBeUndefined();
		expect(readToolCommandNotice(undefined)).toBeUndefined();
	});

	it("reads an embedded then_run check so an applied edit is not styled as a success", () => {
		const details = { changed: true, thenRun: { command: "check", execution: observed(3, "exited") } };
		expect(readToolCommandNotice(details)).toBe("Command exited with code 3");
	});

	it("answers 'did the invocation fail' from the top-level facts only", () => {
		// A failing embedded check describes the check, not the file mutation the
		// call already applied, so wire flags and metrics keep the call successful.
		expect(isToolCommandFailure({ changed: true, thenRun: { execution: observed(3, "exited") } })).toBe(false);
		expect(isToolCommandFailure({ execution: observed(3, "exited") })).toBe(true);
		expect(isToolCommandFailure({ execution: observed(0, "exited") })).toBe(false);
		expect(isToolCommandFailure({})).toBe(false);
	});

	it("ignores malformed facts instead of projecting them", () => {
		expect(readToolCommandNotice({ execution: { status: "exited" } })).toBeUndefined();
		expect(isToolCommandFailure({ execution: { status: "exited" } })).toBe(false);
	});
});
