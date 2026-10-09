import { describe, expect, it } from "vitest";
import { decideAutoClm, resolveAutoClmSettings } from "../src/core/compaction/live-context/auto-options.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const eligible = {
	currentContextTokens: 56000,
	contextWindow: 64000,
	reserveTokens: 8192,
	reducibleTokens: 12000,
	turnsSinceLastAttempt: undefined,
};

describe("host-scheduled CLM settings", () => {
	it("enables bounded maintenance for the default clm-v1 mode", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getAutoClmSettings().enabled).toBe(true);
		expect(settings.getContextProjectionMode()).toBe("clm-v1");
		expect(resolveAutoClmSettings()).toMatchObject({
			enabled: true,
			softThresholdRatio: undefined,
			cooldownTurns: 3,
			maxRequests: 2,
			timeoutMs: 90000,
		});
	});
	it("supports explicit disabling and independent bounded knobs", () => {
		const settings = SettingsManager.inMemory({
			compaction: { autoClm: { enabled: false, softThresholdRatio: 0.7, cooldownTurns: 5 } },
		});
		expect(settings.getAutoClmSettings()).toMatchObject({
			enabled: false,
			softThresholdRatio: 0.7,
			cooldownTurns: 5,
		});
	});
	it("falls back individually for malformed knobs without enabling values by coercion", () => {
		const input = {
			enabled: "true",
			softThresholdRatio: Number.NaN,
			maxRequests: -1,
			minSavingsRatio: 2,
			timeoutMs: 999999999,
		};
		const resolved = resolveAutoClmSettings(input as never);
		expect(resolved).toEqual({ ...resolveAutoClmSettings(), enabled: false });
		expect(input.enabled).toBe("true");
	});
});

describe("automatic CLM budget gate", () => {
	it("inherits the native reserve-token threshold without any plan or model reminder", () => {
		expect(decideAutoClm(eligible)).toEqual({ shouldCompact: true, reason: "native-threshold" });
	});
	it.each([
		{ contextWindow: 64000, reserveTokens: 8192 },
		{ contextWindow: 131072, reserveTokens: 16384 },
		{ contextWindow: 200000, reserveTokens: 30000 },
	])("matches the original strict threshold with %j", ({ contextWindow, reserveTokens }) => {
		const threshold = contextWindow - reserveTokens;
		expect(decideAutoClm({ ...eligible, contextWindow, reserveTokens, currentContextTokens: threshold })).toEqual({
			shouldCompact: false,
			reason: "below-native-threshold",
		});
		expect(decideAutoClm({ ...eligible, contextWindow, reserveTokens, currentContextTokens: threshold + 1 })).toEqual(
			{ shouldCompact: true, reason: "native-threshold" },
		);
	});
	it("still supports an explicitly selected earlier percentage", () => {
		expect(decideAutoClm({ ...eligible, currentContextTokens: 54400 }, { softThresholdRatio: 0.85 })).toEqual({
			shouldCompact: true,
			reason: "soft-threshold",
		});
		expect(decideAutoClm({ ...eligible, currentContextTokens: 54399 }, { softThresholdRatio: 0.85 })).toEqual({
			shouldCompact: false,
			reason: "below-soft-threshold",
		});
	});
	it.each([
		[{ currentContextTokens: 3000 }, "below-min-context"],
		[{ currentContextTokens: 54000 }, "below-native-threshold"],
		[{ reducibleTokens: 500 }, "no-reducible-context"],
		[{ turnsSinceLastAttempt: 2 }, "cooldown"],
		[{ currentContextTokens: 64000 }, "context-overflow"],
		[{ contextWindow: 0 }, "invalid-input"],
	] as const)("does not run unnecessary maintenance for %j", (changes, reason) => {
		expect(decideAutoClm({ ...eligible, ...changes })).toEqual({ shouldCompact: false, reason });
	});
	it("gives actual context overflow recovery precedence even during cooldown", () => {
		expect(decideAutoClm({ ...eligible, currentContextTokens: 64000, turnsSinceLastAttempt: 0 })).toEqual({
			shouldCompact: false,
			reason: "context-overflow",
		});
	});
	it("can be turned off without disabling native compaction", () => {
		expect(decideAutoClm(eligible, { enabled: false })).toEqual({ shouldCompact: false, reason: "disabled" });
	});
});
