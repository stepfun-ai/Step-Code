import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveStepCodeVersion, STEPCODE_FALLBACK_VERSION } from "../src/step/version.ts";

describe("Step product version", () => {
	it("keeps the source fallback in lockstep with the product package", () => {
		const packageJson = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
			version?: unknown;
		};
		expect(packageJson.version).toBe(STEPCODE_FALLBACK_VERSION);
	});

	it("uses the fixed product fallback for an isolated source environment", () => {
		expect(resolveStepCodeVersion({})).toEqual({
			value: STEPCODE_FALLBACK_VERSION,
			source: "fallback",
		});
	});

	it("normalizes release tags and gives explicit overrides precedence", () => {
		expect(resolveStepCodeVersion({ STEPCODE_BUILD_VERSION: "v9.8.7" })).toEqual({
			value: "9.8.7",
			source: "embedded",
		});
		expect(
			resolveStepCodeVersion({
				STEPCODE_BUILD_VERSION: "v9.8.7",
				STEPCODE_VERSION_OVERRIDE: "v1.2.3",
			}),
		).toEqual({ value: "1.2.3", source: "override" });
	});

	it("accepts the StepCode build and override variables", () => {
		expect(resolveStepCodeVersion({ STEPCODE_BUILD_VERSION: "v2.0.0" })).toEqual({
			value: "2.0.0",
			source: "embedded",
		});
		expect(resolveStepCodeVersion({ STEPCODE_VERSION_OVERRIDE: "v2.1.0" })).toEqual({
			value: "2.1.0",
			source: "override",
		});
	});

	it("accepts full CI refs and product-prefixed tags", () => {
		for (const value of ["refs/tags/v3.0.1", "step-v3.0.1", "pi-v3.0.1"]) {
			expect(resolveStepCodeVersion({ STEPCODE_BUILD_VERSION: value })).toEqual({
				value: "3.0.1",
				source: "embedded",
			});
		}
	});
});
