import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
	buildStepSystemPromptAppendix,
	STEP_APP_SYSTEM_PROMPT_PRODUCT,
} from "../../../packages/coding-agent/src/step/system-prompt.ts";

const cliMain = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

/** The `systemPromptProduct` literal `apps/cli/src/main.ts` passes to the runtime. */
function cliProductBlock(source: string): string {
	const start = source.indexOf("systemPromptProduct: {");
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("promptAppendix: buildStepSystemPromptAppendix,", start);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("CLI system prompt product", () => {
	test("uses the shared Step operating contract and no documentation section", () => {
		// The app product carries the same contract. A divergence here changes the
		// model's rules for one host silently, so both are asserted against the
		// same exported builder.
		const block = cliProductBlock(cliMain);
		expect(block).toContain("includeDocumentation: false");
		expect(cliMain).toContain("promptAppendix: buildStepSystemPromptAppendix,");
		expect(STEP_APP_SYSTEM_PROMPT_PRODUCT.promptAppendix).toBe(buildStepSystemPromptAppendix);
	});

	test("keeps the terminal identity in the app layer", () => {
		const block = cliProductBlock(cliMain);
		expect(block).toContain('name: "StepCode"');
		expect(block).toContain("interactive terminal coding agent");
		// The app product owns the non-terminal wording; the CLI must not reuse it.
		expect(block).not.toContain("running in the StepCode app");
	});
});
