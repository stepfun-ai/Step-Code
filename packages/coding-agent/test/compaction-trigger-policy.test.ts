import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_TRIGGER_RATIO,
	resolveCompactionThreshold,
	resolveCompactionTriggerSettings,
} from "../src/core/compaction/trigger-policy.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const model = (contextWindow: number, id = "m") => ({ provider: "p", id, contextWindow });

describe("compaction trigger policy", () => {
	it.each([
		[64_000, 57_600],
		[128_000, 115_200],
		[200_000, 180_000],
		[1_000_000, 900_000],
	])("triggers at 90%% of a %i-token window by default", (contextWindow, threshold) => {
		const { settings, warnings } = resolveCompactionTriggerSettings();
		expect(warnings).toEqual([]);
		expect(settings.policy).toBe("v2");
		expect(settings.triggerRatio).toBe(DEFAULT_COMPACTION_TRIGGER_RATIO);
		expect(resolveCompactionThreshold(model(contextWindow), settings)).toBe(threshold);
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
