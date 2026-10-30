import { CONTEXT_SAFETY_TOKENS } from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_TRIGGER_RATIO,
	MIN_RESPONSE_OUTPUT_TOKENS,
	resolveCompactionThreshold,
	resolveCompactionTriggerSettings,
} from "../src/core/compaction/trigger-policy.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const model = (contextWindow: number, id = "m", maxTokens?: number) => ({
	provider: "p",
	id,
	contextWindow,
	maxTokens,
});

describe("compaction trigger policy", () => {
	it.each([
		[128_000, 115_200],
		[131_072, 117_964],
		[200_000, 180_000],
		[1_000_000, 900_000],
	])("triggers at 90%% of a %i-token window by default", (contextWindow, threshold) => {
		const { settings, warnings } = resolveCompactionTriggerSettings();
		expect(warnings).toEqual([]);
		expect(settings.policy).toBe("v2");
		expect(settings.triggerRatio).toBe(DEFAULT_COMPACTION_TRIGGER_RATIO);
		expect(resolveCompactionThreshold(model(contextWindow), settings)).toBe(threshold);
	});

	it.each([
		// window, model output limit, threshold
		[65_536, 65_536, 53_248],
		[64_000, undefined, 51_712],
		[32_768, 32_768, 20_480],
		[32_768, 4_096, 24_576],
		[16_384, 16_384, 8_192],
		[8_192, 8_192, 4_096],
	])("keeps response room on a %i-token window with output limit %s", (contextWindow, maxTokens, threshold) => {
		const settings = resolveCompactionTriggerSettings().settings;
		expect(resolveCompactionThreshold(model(contextWindow, "m", maxTokens), settings)).toBe(threshold);
		// Below the floor, the threshold is half the window; otherwise the provider's
		// context-clamped output budget at the threshold is at least the reserved room.
		if (threshold > contextWindow / 2) {
			const reserved = Math.min(maxTokens ?? MIN_RESPONSE_OUTPUT_TOKENS, MIN_RESPONSE_OUTPUT_TOKENS);
			expect(contextWindow - threshold - CONTEXT_SAFETY_TOKENS).toBeGreaterThanOrEqual(reserved);
		}
	});

	it("lets a lower ratio trigger earlier than the response-room ceiling", () => {
		const { settings } = resolveCompactionTriggerSettings({ triggerRatio: 0.5 });
		expect(resolveCompactionThreshold(model(32_768, "m", 32_768), settings)).toBe(16_384);
		// A higher per-model ratio cannot exceed the ceiling on a small window.
		const high = resolveCompactionTriggerSettings({ modelTriggerRatios: { "p/m": 0.95 } }).settings;
		expect(resolveCompactionThreshold(model(32_768, "m", 32_768), high)).toBe(20_480);
	});

	it("applies global and per-model ratios", () => {
		const { settings } = resolveCompactionTriggerSettings({
			triggerRatio: 0.8,
			modelTriggerRatios: { "p/small": 0.7 },
		});
		expect(resolveCompactionThreshold(model(100_000), settings)).toBe(80_000);
		expect(resolveCompactionThreshold(model(100_000, "small"), settings)).toBe(70_000);
	});

	it("lets tokenLimit and an explicit legacy reserve only trigger earlier", () => {
		expect(
			resolveCompactionThreshold(model(200_000), resolveCompactionTriggerSettings({ tokenLimit: 150_000 }).settings),
		).toBe(150_000);
		expect(
			resolveCompactionThreshold(model(200_000), resolveCompactionTriggerSettings({ tokenLimit: 500_000 }).settings),
		).toBe(180_000);
		expect(
			resolveCompactionThreshold(
				model(1_048_576),
				resolveCompactionTriggerSettings({ reserveTokens: 851_968 }).settings,
			),
		).toBe(196_608);
		expect(
			resolveCompactionThreshold(
				model(200_000),
				resolveCompactionTriggerSettings({ reserveTokens: 8_192 }).settings,
			),
		).toBe(180_000);
		// A reserve that leaves no room is ignored rather than triggering on every request.
		for (const reserveTokens of [200_000, 250_000]) {
			expect(
				resolveCompactionThreshold(model(200_000), resolveCompactionTriggerSettings({ reserveTokens }).settings),
			).toBe(180_000);
		}
	});

	it("returns no threshold for an unknown window", () => {
		expect(resolveCompactionThreshold(model(0), resolveCompactionTriggerSettings().settings)).toBeUndefined();
	});

	it("falls back to defaults and reports invalid values", () => {
		const { settings, warnings } = resolveCompactionTriggerSettings({
			triggerPolicy: "eager",
			triggerRatio: 0.99,
			modelTriggerRatios: { "p/a": 0.2, "p/b": 0.6 },
			tokenLimit: -1,
		});
		expect(settings).toEqual({
			policy: "v2",
			triggerRatio: DEFAULT_COMPACTION_TRIGGER_RATIO,
			modelTriggerRatios: { "p/b": 0.6 },
			tokenLimit: undefined,
			legacyReserveTokens: undefined,
		});
		expect(warnings).toHaveLength(4);
		expect(resolveCompactionTriggerSettings({ modelTriggerRatios: [0.8] }).warnings).toHaveLength(1);
	});

	it("reports invalid trigger settings as settings diagnostics and accepts the legacy policy", () => {
		const invalid = SettingsManager.inMemory({ compaction: { triggerRatio: 2 } });
		expect(invalid.getCompactionTriggerSettings().triggerRatio).toBe(DEFAULT_COMPACTION_TRIGGER_RATIO);
		expect(invalid.drainErrors().map((error) => error.error.message)).toEqual([
			expect.stringContaining("compaction.triggerRatio"),
		]);

		const legacy = SettingsManager.inMemory({ compaction: { triggerPolicy: "legacy" } });
		expect(legacy.getCompactionTriggerSettings().policy).toBe("legacy");
		expect(legacy.drainErrors()).toEqual([]);
	});
});
