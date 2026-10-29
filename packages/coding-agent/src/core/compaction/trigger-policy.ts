/**
 * Automatic compaction trigger policy.
 *
 * The threshold is a fraction of the model's context window. No absolute
 * output reserve or buffer is subtracted: providers already clamp each
 * request's `max_tokens` to the remaining context, and a response truncated
 * by that clamp is recovered by the overflow/length path. The remaining
 * fraction absorbs token-estimation error and scales with the window.
 */

export type CompactionTriggerPolicy = "v2" | "legacy";

export const DEFAULT_COMPACTION_TRIGGER_RATIO = 0.9;
export const MIN_COMPACTION_TRIGGER_RATIO = 0.5;
export const MAX_COMPACTION_TRIGGER_RATIO = 0.95;

export interface CompactionTriggerSettings {
	policy: CompactionTriggerPolicy;
	/** Global fraction of the context window that triggers compaction. */
	triggerRatio: number;
	/** Per-model overrides keyed by `provider/id`. */
	modelTriggerRatios: Readonly<Record<string, number>>;
	/** Absolute ceiling that can only make compaction trigger earlier. */
	tokenLimit?: number;
	/** Explicitly configured legacy reserve; caps the trigger at `contextWindow - reserveTokens` when smaller than the window. */
	legacyReserveTokens?: number;
}

export interface CompactionTriggerModel {
	provider: string;
	id: string;
	contextWindow: number;
}

/** Raw configuration fields read from the `compaction` settings object. */
export interface RawCompactionTriggerSettings {
	triggerPolicy?: unknown;
	triggerRatio?: unknown;
	modelTriggerRatios?: unknown;
	tokenLimit?: unknown;
	reserveTokens?: unknown;
}

export interface ResolvedCompactionTriggerSettings {
	settings: CompactionTriggerSettings;
	/** Human-readable descriptions of ignored values. */
	warnings: string[];
}

function isValidRatio(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= MIN_COMPACTION_TRIGGER_RATIO &&
		value <= MAX_COMPACTION_TRIGGER_RATIO
	);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const RATIO_RANGE = `${MIN_COMPACTION_TRIGGER_RATIO}-${MAX_COMPACTION_TRIGGER_RATIO}`;

/** Validate trigger configuration; invalid values fall back to defaults and are reported. */
export function resolveCompactionTriggerSettings(
	raw: RawCompactionTriggerSettings = {},
): ResolvedCompactionTriggerSettings {
	const warnings: string[] = [];

	let policy: CompactionTriggerPolicy = "v2";
	if (raw.triggerPolicy === "legacy" || raw.triggerPolicy === "v2") policy = raw.triggerPolicy;
	else if (raw.triggerPolicy !== undefined)
		warnings.push(`compaction.triggerPolicy must be "v2" or "legacy"; using "v2".`);

	let triggerRatio = DEFAULT_COMPACTION_TRIGGER_RATIO;
	if (isValidRatio(raw.triggerRatio)) triggerRatio = raw.triggerRatio;
	else if (raw.triggerRatio !== undefined)
		warnings.push(
			`compaction.triggerRatio must be a number in ${RATIO_RANGE}; using ${DEFAULT_COMPACTION_TRIGGER_RATIO}.`,
		);

	const modelTriggerRatios: Record<string, number> = {};
	if (raw.modelTriggerRatios !== undefined) {
		if (
			typeof raw.modelTriggerRatios !== "object" ||
			raw.modelTriggerRatios === null ||
			Array.isArray(raw.modelTriggerRatios)
		) {
			warnings.push("compaction.modelTriggerRatios must be a table keyed by provider/model; ignoring it.");
		} else {
			for (const [key, value] of Object.entries(raw.modelTriggerRatios)) {
				if (isValidRatio(value)) modelTriggerRatios[key] = value;
				else
					warnings.push(
						`compaction.modelTriggerRatios["${key}"] must be a number in ${RATIO_RANGE}; ignoring it.`,
					);
			}
		}
	}

	let tokenLimit: number | undefined;
	if (isPositiveSafeInteger(raw.tokenLimit)) tokenLimit = raw.tokenLimit;
	else if (raw.tokenLimit !== undefined)
		warnings.push("compaction.tokenLimit must be a positive integer; ignoring it.");

	// reserveTokens is validated by its existing owner; only a usable explicit value participates here.
	const legacyReserveTokens = isPositiveSafeInteger(raw.reserveTokens) ? raw.reserveTokens : undefined;

	return { settings: { policy, triggerRatio, modelTriggerRatios, tokenLimit, legacyReserveTokens }, warnings };
}

/** Trigger ratio that applies to `model`, honoring per-model overrides. */
export function resolveTriggerRatio(
	model: Pick<CompactionTriggerModel, "provider" | "id">,
	settings: CompactionTriggerSettings,
): number {
	return settings.modelTriggerRatios[`${model.provider}/${model.id}`] ?? settings.triggerRatio;
}

/**
 * Token count above which automatic compaction runs for `model`.
 * Returns undefined when the context window is unknown.
 */
export function resolveCompactionThreshold(
	model: CompactionTriggerModel,
	settings: CompactionTriggerSettings,
): number | undefined {
	const contextWindow = model.contextWindow;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	let threshold = Math.floor(contextWindow * resolveTriggerRatio(model, settings));
	if (settings.tokenLimit !== undefined) threshold = Math.min(threshold, settings.tokenLimit);
	if (settings.legacyReserveTokens !== undefined && settings.legacyReserveTokens < contextWindow)
		threshold = Math.min(threshold, contextWindow - settings.legacyReserveTokens);
	return Math.max(0, threshold);
}
