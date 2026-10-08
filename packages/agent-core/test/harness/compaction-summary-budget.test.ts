import { describe, expect, it } from "vitest";
import { pickSummaryMaxTokens } from "../../src/harness/compaction/compaction.ts";

describe("summary output budget", () => {
	it.each([
		{ name: "default model budget", modelMax: 65536, reserve: 24576, history: 32000, prefix: 32000 },
		{ name: "session default reserve", modelMax: 65536, reserve: 16384, history: 32000, prefix: 32000 },
		{ name: "early trigger reserve", modelMax: 65536, reserve: 851968, history: 32000, prefix: 32000 },
		{ name: "lower model cap", modelMax: 8192, reserve: 851968, history: 8192, prefix: 8192 },
		{ name: "unknown zero budget", modelMax: 0, reserve: 851968, history: 32000, prefix: 32000 },
		{ name: "unknown negative budget", modelMax: -1, reserve: 851968, history: 32000, prefix: 32000 },
		{ name: "default unknown budget", modelMax: 0, reserve: 24576, history: 19660, prefix: 12288 },
		{ name: "small unknown budget", modelMax: -1, reserve: 2000, history: 1600, prefix: 1000 },
	])("bounds history and prefix output with $name", ({ modelMax, reserve, history, prefix }) => {
		expect(pickSummaryMaxTokens({ maxTokens: modelMax }, reserve, 0.8)).toBe(history);
		expect(pickSummaryMaxTokens({ maxTokens: modelMax }, reserve, 0.5)).toBe(prefix);
	});
});
