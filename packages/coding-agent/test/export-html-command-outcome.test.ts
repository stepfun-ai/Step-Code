import { readFileSync } from "node:fs";
import type { CommandExecutionOutcome } from "@step-harness/agent-core";
import { describe, expect, it } from "vitest";

/**
 * The export template is a static asset, so it cannot import the agent-core
 * formatter. These cases pin the two implementations to the same answers; a
 * wording change must reach both, and an extraction failure fails loudly
 * instead of silently skipping the check.
 */
const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

function extractFunction(name: string): (...args: unknown[]) => unknown {
	const start = templateJs.indexOf(`function ${name}(`);
	expect(start, `${name} is missing from the export template`).toBeGreaterThan(-1);
	const end = templateJs.indexOf("\n      }", start);
	expect(end, `${name} could not be delimited in the export template`).toBeGreaterThan(start);
	const source = templateJs.slice(start, end + "\n      }".length);
	return new Function(`${source}; return ${name};`)() as (...args: unknown[]) => unknown;
}

const label = extractFunction("commandOutcomeLabel") as (execution: unknown) => string;
const failed = extractFunction("commandOutcomeFailed") as (execution: unknown, fallback: boolean) => boolean;
const executionOf = extractFunction("commandExecutionOf") as (result: unknown) => unknown;

function outcome(overrides: Partial<CommandExecutionOutcome>): CommandExecutionOutcome {
	return {
		status: "exited",
		exitCode: 0,
		signal: null,
		timedOut: false,
		aborted: false,
		...overrides,
	};
}

describe("export HTML command outcome rendering", () => {
	it("says nothing for a clean exit", () => {
		expect(label(outcome({}))).toBe("");
		expect(failed(outcome({}), true)).toBe(false);
	});

	it("reports a nonzero exit", () => {
		expect(label(outcome({ exitCode: 3 }))).toBe("Command exited with code 3");
		expect(failed(outcome({ exitCode: 3 }), false)).toBe(true);
	});

	it("reports signals and deadlines independently of the exit code", () => {
		expect(label(outcome({ status: "signaled", exitCode: null, signal: "SIGKILL" }))).toBe(
			"Command terminated by signal SIGKILL",
		);
		const deadline = outcome({ status: "timed_out", exitCode: 0, timedOut: true, timeoutSeconds: 2 });
		expect(label(deadline)).toBe("Command timed out after 2 seconds");
		expect(failed(deadline, false)).toBe(true);
	});

	it("reports cancellation and unknown exits", () => {
		expect(label(outcome({ status: "canceled", exitCode: null, aborted: true }))).toBe("Command aborted");
		expect(label(outcome({ status: "unknown", exitCode: null }))).toContain("check its effects");
	});

	it("reads an embedded then_run check so an applied mutation is not styled as a success", () => {
		const check = outcome({ exitCode: 3 });
		expect(executionOf({ details: { changed: true, thenRun: { execution: check } } })).toBe(check);
		expect(failed(executionOf({ details: { changed: true, thenRun: { execution: check } } }), false)).toBe(true);
		expect(executionOf({ details: { changed: true } })).toBeUndefined();
		expect(executionOf({})).toBeUndefined();
	});

	it("falls back to the legacy flag when a record has no execution facts", () => {
		expect(label(undefined)).toBe("");
		expect(failed(undefined, true)).toBe(true);
		expect(failed(undefined, false)).toBe(false);
	});
});
