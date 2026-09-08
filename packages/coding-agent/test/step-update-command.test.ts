import { describe, expect, test, vi } from "vitest";
import { parseStepUpdateCommand } from "../src/step/command-compat.ts";
import { normalizeStepStableVersion, runStepUpdateCommand } from "../src/step/local-update.ts";

describe("Step update command", () => {
	test.each([
		["update", { command: "update" }],
		["update 0.4.0", { command: "update", version: "0.4.0" }],
		["upgrade", { command: "upgrade" }],
		["upgrade v0.4.0", { command: "upgrade", version: "0.4.0" }],
	])("parses %s", (input, expected) => {
		expect(parseStepUpdateCommand(input.split(" "))).toEqual(expected);
	});

	test.each(["update --self", "update --all", "update --extensions", "upgrade --force", "update 0.4.0 extra"])(
		"rejects unsupported form %s",
		(input) => {
			const parsed = parseStepUpdateCommand(input.split(" "));
			expect(parsed).toEqual(expect.objectContaining({ error: expect.any(String) }));
		},
	);

	test("accepts release tag prefixes for exact versions", () => {
		expect(normalizeStepStableVersion("refs/tags/step-v0.4.0")).toBe("0.4.0");
		expect(normalizeStepStableVersion("0.4.0-beta.1")).toBeNull();
	});

	test("rejects a non-standalone invocation before contacting the release service", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const exitCode = await runStepUpdateCommand({ executablePath: "/tmp/step-source-entrypoint", fetchImpl });
		expect(exitCode).toBe(1);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
