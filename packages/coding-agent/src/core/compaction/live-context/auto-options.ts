/** Host scheduling bounds for CLM working context. */
export interface AutoClmSettings {
	enabled: boolean;
	/** An explicit earlier trigger; omitted uses native contextWindow - reserveTokens. */
	softThresholdRatio?: number;
	minContextTokens: number;
	cooldownTurns: number;
	maxRequests: number;
	timeoutMs: number;
	maxOutputTokens: number;
	minSavingsTokens: number;
	minSavingsRatio: number;
}

export const DEFAULT_AUTO_CLM_SETTINGS: Readonly<AutoClmSettings> = Object.freeze({
	enabled: true,
	minContextTokens: 8_000,
	cooldownTurns: 3,
	maxRequests: 2,
	timeoutMs: 90_000,
	maxOutputTokens: 8_192,
	minSavingsTokens: 1_024,
	minSavingsRatio: 0.05,
});

function number(value: unknown, fallback: number, min: number, max: number, integer = false): number {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= min &&
		value <= max &&
		(!integer || Number.isInteger(value))
		? value
		: fallback;
}

export function resolveAutoClmSettings(settings?: Partial<AutoClmSettings>): AutoClmSettings {
	const raw = settings ?? {};
	const defaults = DEFAULT_AUTO_CLM_SETTINGS;
	return {
		enabled: raw.enabled === undefined ? defaults.enabled : raw.enabled === true,
		softThresholdRatio:
			typeof raw.softThresholdRatio === "number" &&
			Number.isFinite(raw.softThresholdRatio) &&
			raw.softThresholdRatio >= 0.3 &&
			raw.softThresholdRatio <= 0.85
				? raw.softThresholdRatio
				: undefined,
		minContextTokens: number(raw.minContextTokens, defaults.minContextTokens, 1_024, 1_000_000, true),
		cooldownTurns: number(raw.cooldownTurns, defaults.cooldownTurns, 1, 100, true),
		maxRequests: number(raw.maxRequests, defaults.maxRequests, 1, 3, true),
		timeoutMs: number(raw.timeoutMs, defaults.timeoutMs, 100, 300_000, true),
		maxOutputTokens: number(raw.maxOutputTokens, defaults.maxOutputTokens, 512, 32_768, true),
		minSavingsTokens: number(raw.minSavingsTokens, defaults.minSavingsTokens, 1, 1_000_000, true),
		minSavingsRatio: number(raw.minSavingsRatio, defaults.minSavingsRatio, 0.01, 0.5),
	};
}

export interface AutoClmInput {
	currentContextTokens: number;
	contextWindow: number;
	reserveTokens: number;
	reducibleTokens: number;
	turnsSinceLastAttempt?: number;
}

export function decideAutoClm(input: AutoClmInput, options?: Partial<AutoClmSettings>) {
	const settings = resolveAutoClmSettings(options);
	let reason:
		| "disabled"
		| "invalid-input"
		| "native-threshold"
		| "context-overflow"
		| "below-native-threshold"
		| "below-min-context"
		| "below-soft-threshold"
		| "no-reducible-context"
		| "cooldown"
		| "soft-threshold";
	const { currentContextTokens, contextWindow, reserveTokens, reducibleTokens, turnsSinceLastAttempt } = input;
	if (!settings.enabled) reason = "disabled";
	else if (
		![currentContextTokens, contextWindow, reserveTokens, reducibleTokens].every(
			(value) => Number.isFinite(value) && value >= 0,
		) ||
		contextWindow <= 0 ||
		(turnsSinceLastAttempt !== undefined &&
			(!Number.isSafeInteger(turnsSinceLastAttempt) || turnsSinceLastAttempt < 0))
	)
		reason = "invalid-input";
	else if (currentContextTokens >= contextWindow) reason = "context-overflow";
	else if (currentContextTokens < settings.minContextTokens) reason = "below-min-context";
	else if (
		currentContextTokens <= contextWindow - reserveTokens &&
		(settings.softThresholdRatio === undefined || currentContextTokens < contextWindow * settings.softThresholdRatio)
	)
		reason = settings.softThresholdRatio === undefined ? "below-native-threshold" : "below-soft-threshold";
	else if (reducibleTokens < Math.max(settings.minSavingsTokens, currentContextTokens * settings.minSavingsRatio))
		reason = "no-reducible-context";
	else if (turnsSinceLastAttempt !== undefined && turnsSinceLastAttempt < settings.cooldownTurns) reason = "cooldown";
	else reason = currentContextTokens > contextWindow - reserveTokens ? "native-threshold" : "soft-threshold";
	return { shouldCompact: reason === "soft-threshold" || reason === "native-threshold", reason };
}
