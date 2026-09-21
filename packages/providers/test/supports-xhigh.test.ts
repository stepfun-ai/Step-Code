import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/compat.ts";
import { anthropicModel, responsesModel } from "./helpers/step-fixtures.ts";

// The generated catalog is empty in the Step-only build, so these exercise the
// getSupportedThinkingLevels logic directly with explicit thinkingLevelMap inputs
// rather than asserting specific vendor catalog models.
describe("getSupportedThinkingLevels", () => {
	it("returns only off for a non-reasoning model", () => {
		expect(getSupportedThinkingLevels(anthropicModel({ reasoning: false }))).toEqual(["off"]);
	});

	it("includes max but not xhigh when only max is mapped", () => {
		const levels = getSupportedThinkingLevels(anthropicModel({ thinkingLevelMap: { max: "max" } }));
		expect(levels).toContain("max");
		expect(levels).not.toContain("xhigh");
	});

	it("includes xhigh and max when both are mapped", () => {
		const levels = getSupportedThinkingLevels(anthropicModel({ thinkingLevelMap: { xhigh: "xhigh", max: "max" } }));
		expect(levels).toContain("xhigh");
		expect(levels).toContain("max");
	});

	it("excludes a level explicitly mapped to null", () => {
		const levels = getSupportedThinkingLevels(
			anthropicModel({ thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } }),
		);
		expect(levels).not.toContain("off");
		expect(levels).toContain("xhigh");
	});

	it("includes the full extended set for a fully-mapped model", () => {
		const levels = getSupportedThinkingLevels(responsesModel({ thinkingLevelMap: { xhigh: "xhigh", max: "max" } }));
		expect(levels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("excludes xhigh and max when neither is mapped", () => {
		const levels = getSupportedThinkingLevels(anthropicModel({ thinkingLevelMap: {} }));
		expect(levels).not.toContain("xhigh");
		expect(levels).not.toContain("max");
	});
});
