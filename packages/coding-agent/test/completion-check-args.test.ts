import { describe, expect, it, vi } from "vitest";
import { parseArgs, printHelp } from "../src/cli/args.ts";

describe("completion-check CLI options", () => {
	it("is off by default", () => {
		const parsed = parseArgs(["-p", "task"]);
		expect(parsed.completionCheck).toBeUndefined();
		expect(parsed.completionCheckAttempts).toBeUndefined();
		expect(parsed.diagnostics).toEqual([]);
	});

	it("defaults to two additional prompts and preserves user messages", () => {
		const parsed = parseArgs(["--completion-check", "git-committed", "-p", "first", "second"]);
		expect(parsed.completionCheck).toBe("git-committed");
		expect(parsed.completionCheckAttempts).toBe(2);
		expect(parsed.messages).toEqual(["first", "second"]);
		expect(parsed.unknownFlags.size).toBe(0);
		expect(parsed.diagnostics).toEqual([]);
	});

	it.each([1, 2, 3])("accepts a bound of %i in both CLI syntaxes", (attempts) => {
		for (const flags of [
			["--completion-check", "git-committed", "--completion-check-attempts", String(attempts)],
			[`--completion-check-attempts=${attempts}`, "--completion-check=git-committed"],
		]) {
			const parsed = parseArgs(["--mode", "json", ...flags, "task"]);
			expect(parsed.completionCheckAttempts).toBe(attempts);
			expect(parsed.messages).toEqual(["task"]);
			expect(parsed.unknownFlags.size).toBe(0);
			expect(parsed.diagnostics).toEqual([]);
		}
	});

	it.each(["", "0", "4", "100", "-1", "1.5", "02", "2x", "2e0", "NaN", "Infinity"])(
		"rejects an invalid bound %j",
		(value) => {
			const parsed = parseArgs([
				"-p",
				"task",
				"--completion-check=git-committed",
				`--completion-check-attempts=${value}`,
			]);
			expect(parsed.diagnostics).toContainEqual({
				type: "error",
				message: "--completion-check-attempts must be an integer from 1 to 3",
			});
			expect(parsed.messages).toEqual(["task"]);
		},
	);

	it.each(["--completion-check", "--completion-check-attempts"])("requires a value for %s", (flag) => {
		for (const tail of [[], ["--verbose"]]) {
			const parsed = parseArgs([flag, ...tail]);
			expect(parsed.diagnostics).toContainEqual({ type: "error", message: `${flag} requires a value` });
			if (tail.length) expect(parsed.verbose).toBe(true);
		}
	});

	it.each(["", "off", "git", "git status; echo unsafe"])("rejects an unsupported check %j", (value) => {
		const parsed = parseArgs(["--completion-check", value]);
		expect(parsed.diagnostics).toContainEqual({ type: "error", message: "--completion-check must be git-committed" });
		expect(parsed.messages).toEqual([]);
	});

	it("requires the check when configuring attempts", () => {
		expect(parseArgs(["--completion-check-attempts", "2"]).diagnostics).toEqual([
			{ type: "error", message: "--completion-check-attempts requires --completion-check git-committed" },
		]);
	});

	it.each([["--mode", "rpc"], ["--sdk-stdio"]])("rejects incompatible mode %j", (...flags) => {
		const parsed = parseArgs(["--completion-check", "git-committed", ...flags]);
		expect(parsed.diagnostics).toContainEqual({
			type: "error",
			message: "--completion-check is only supported in print or JSON mode",
		});
	});

	it("leaves arguments after -- as literal user messages", () => {
		const parsed = parseArgs(["-p", "--", "--completion-check", "git-committed"]);
		expect(parsed.completionCheck).toBeUndefined();
		expect(parsed.messages).toEqual(["--completion-check", "git-committed"]);
	});

	it("documents opt-in behavior and the follow-up bound in help", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			printHelp();
			const help = String(log.mock.calls[0]?.[0]);
			expect(help).toContain("--completion-check <check>");
			expect(help).toContain("git-committed");
			expect(help).toContain("--completion-check-attempts <n>");
			expect(help).toContain("1..3 (default: 2)");
		} finally {
			log.mockRestore();
		}
	});
});
