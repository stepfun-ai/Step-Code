import { describe, expect, test } from "vitest";
import { normalizeStepSessionSelectorArgs } from "../src/step/command-compat.ts";

describe("normalizeStepSessionSelectorArgs", () => {
	test("leaves argv untouched when no legacy --session-file is present", () => {
		const argv = ["-p", "hello", "--model", "step-3"];
		expect(normalizeStepSessionSelectorArgs(argv)).toEqual(argv);
	});

	test("maps a UUID selector to --session-id (stepcode's injected form)", () => {
		const id = "29a35ca0-1f73-468e-8fd0-27f334b4fdd0";
		expect(normalizeStepSessionSelectorArgs(["--session-file", id, "-p", "hi"])).toEqual([
			"-p",
			"hi",
			"--session-id",
			id,
		]);
	});

	test("supports the --session-file=<value> inline form", () => {
		const id = "abc123";
		expect(normalizeStepSessionSelectorArgs([`--session-file=${id}`, "-p", "hi"])).toEqual([
			"-p",
			"hi",
			"--session-id",
			id,
		]);
	});

	test("drops the default 'session' selector so a fresh session is created", () => {
		expect(normalizeStepSessionSelectorArgs(["--session-file", "session", "-p", "hi"])).toEqual(["-p", "hi"]);
	});

	test("uses the basename without extension, matching stepcode deriveSessionTarget", () => {
		expect(normalizeStepSessionSelectorArgs(["--session-file", "/tmp/my-run.json"])).toEqual([
			"--session-id",
			"my-run",
		]);
	});

	test("drops the legacy flag when an explicit --session-id is already present", () => {
		expect(normalizeStepSessionSelectorArgs(["--session-id", "keep-me", "--session-file", "other"])).toEqual([
			"--session-id",
			"keep-me",
		]);
	});

	test("drops the legacy flag when --resume is present so it cannot conflict", () => {
		expect(normalizeStepSessionSelectorArgs(["--resume", "--session-file", "ignored"])).toEqual(["--resume"]);
	});

	test("drops selectors that are not valid Pi session ids instead of erroring", () => {
		expect(normalizeStepSessionSelectorArgs(["--session-file", "not a session id", "-p", "hi"])).toEqual([
			"-p",
			"hi",
		]);
	});

	// A flag-like token is never the selector's value: consuming `-p` silently
	// dropped it and switched the run from print mode back to interactive.
	test("does not consume a following short flag as the selector", () => {
		expect(normalizeStepSessionSelectorArgs(["--session-file", "-p", "hi"])).toEqual(["-p", "hi"]);
		expect(normalizeStepSessionSelectorArgs(["--session-file", "-t", "read", "-p", "hi"])).toEqual([
			"-t",
			"read",
			"-p",
			"hi",
		]);
	});

	test("does not consume a following long flag as the selector", () => {
		expect(normalizeStepSessionSelectorArgs(["--session-file", "--version"])).toEqual(["--version"]);
	});

	test("only rewrites the portion before a -- separator", () => {
		expect(normalizeStepSessionSelectorArgs(["--session-file", "run1", "--", "--session-file", "verbatim"])).toEqual([
			"--session-id",
			"run1",
			"--",
			"--session-file",
			"verbatim",
		]);
	});
});
