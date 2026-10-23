/** Model picker helpers (legacy app.js 2480-2488, 2558-2584, 2614-2616, 2809-2818). */

import type { TranslateFn } from "../../i18n";
import { readStorage, STORAGE_KEYS, writeStorage } from "../../lib/storage";
import { modelKey } from "../../state/session";
import type { DraftModels, ModelInfo, SessionSnapshot } from "../../state/types";

/** How many models the current provider may list before the panel adds a search field. */
export const MODEL_SEARCH_THRESHOLD = 8;

/** What the model panel is painted from: the open session, or a draft's prediction (`draftModelSource`). */
export type ModelSource = Pick<SessionSnapshot, "models" | "model" | "thinkingLevel" | "availableThinkingLevels">;

export const EMPTY_MODEL_SOURCE: ModelSource = { models: [] };

/** Kernel thinking levels, lowest first (the order of `EFFORT_LABELS`). */
const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The level a session on a model with `levels` would actually run at for
 * `level`. Mirrors the kernel's `clampThinkingLevel`: `level` itself, else the
 * nearest supported level above it, else the nearest below, else the lowest
 * supported one. A draft that rounded differently would show one effort and
 * start its session on another.
 */
export function clampEffort(level: string, levels: readonly string[]): string | undefined {
	if (levels.includes(level)) return level;
	const rank = EFFORT_ORDER.indexOf(level);
	if (rank === -1) return levels[0];
	const above = EFFORT_ORDER.slice(rank + 1).find((candidate) => levels.includes(candidate));
	const below = EFFORT_ORDER.slice(0, rank)
		.reverse()
		.find((candidate) => levels.includes(candidate));
	return above ?? below ?? levels[0];
}

/**
 * What a draft's model panel shows: the host's prediction for a new session
 * (`GET /api/v1/models`), with the model and effort picked in this draft laid
 * over it. A picked model brings its own supported levels.
 */
export function draftModelSource(draft: DraftModels | null, pickedModel: string, pickedEffort: string): ModelSource {
	if (!draft) return EMPTY_MODEL_SOURCE;
	const picked = pickedModel ? draft.models.find((model) => modelKey(model) === pickedModel) : undefined;
	if (!picked) {
		const thinkingLevel = pickedEffort
			? clampEffort(pickedEffort, draft.availableThinkingLevels)
			: draft.thinkingLevel;
		return { ...draft, thinkingLevel };
	}
	const levels = picked.thinkingLevels ?? [];
	const wanted = pickedEffort || draft.thinkingLevel;
	return {
		models: draft.models,
		model: { provider: picked.provider, id: picked.id },
		availableThinkingLevels: levels,
		thinkingLevel: wanted ? clampEffort(wanted, levels) : undefined,
	};
}

/** Effort labels, keyed by the kernel's thinking level ids. */
export const EFFORT_LABELS: Readonly<Record<string, string>> = {
	off: "effortOff",
	minimal: "effortMinimal",
	low: "effortLow",
	medium: "effortMedium",
	high: "effortHigh",
	xhigh: "effortXhigh",
	max: "effortMax",
};

export function effortLabel(t: TranslateFn, level: string): string {
	return t(EFFORT_LABELS[level] ?? level);
}

/**
 * The model picked last under each provider, so switching providers — and
 * switching back — restores the model the user was on instead of the catalog's
 * first row. localStorage only; a lost preference is a minor annoyance.
 */
export function readLastModelByProvider(): Record<string, string> {
	try {
		const parsed: unknown = JSON.parse(readStorage(STORAGE_KEYS.lastModelByProvider) ?? "{}");
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed as Record<string, unknown>).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
	} catch {
		return {};
	}
}

export function rememberModelChoice(provider: string, key: string): void {
	const next = { ...readLastModelByProvider(), [provider]: key };
	writeStorage(STORAGE_KEYS.lastModelByProvider, JSON.stringify(next));
}

/**
 * The model a provider switch lands on: the one remembered for the target
 * provider, else its first listed one. `current` (already on that provider)
 * short-circuits — the caller keeps the model and only repaints.
 */
export function providerSwitchTarget(group: Pick<ModelGroup, "models">, remembered: string | undefined): ModelInfo {
	return group.models.find((model) => modelKey(model) === remembered) ?? group.models[0];
}

/** Human-readable model metadata for the picker rows (strings hard-coded in Chinese, as legacy). */
export function modelMeta(model: ModelInfo): string[] {
	const meta: string[] = [];
	if (model.contextWindow) meta.push(`${Math.round(model.contextWindow / 1000)}K 上下文`);
	if (model.maxTokens) meta.push(`${Math.round(model.maxTokens / 1000)}K 输出`);
	if (model.input?.includes("image")) meta.push("支持图片");
	return meta;
}

/** `#modelLabel`: model name (or id), then ` · <effort>` when a level is set. */
/**
 * The trigger label in its two parts: the model name, which may be long and is
 * the part the trigger shortens, and the effort suffix (` · 高`), which stays
 * whole so the chosen effort is always readable.
 */
export function modelLabelParts(
	t: TranslateFn,
	source: ModelSource,
): { readonly name: string; readonly effort: string } {
	const currentKey = source.model ? modelKey(source.model) : "";
	const active = (source.models ?? []).find((model) => modelKey(model) === currentKey);
	const effort = source.thinkingLevel;
	return {
		// `defaultModel` has no translation: legacy showed the key itself here.
		name: active?.name ?? (currentKey && source.model ? source.model.id : t("defaultModel")),
		effort: effort ? ` · ${effortLabel(t, effort)}` : "",
	};
}

/**
 * Model ids the user favourited, kept locally so they survive a session
 * change. A favourited model is pinned to the top of its provider's list.
 */
export function readPinnedModels(): string[] {
	try {
		const parsed: unknown = JSON.parse(readStorage(STORAGE_KEYS.pinnedModels) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

export function togglePinnedModel(key: string): string[] {
	const current = readPinnedModels();
	const next = current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key];
	writeStorage(STORAGE_KEYS.pinnedModels, JSON.stringify(next));
	return next;
}

/**
 * A provider's models with the favourited ones first, in the order they were
 * favourited; keys pinned under other providers are ignored, so each list pins
 * only its own.
 */
export function pinFirst(models: readonly ModelInfo[], pinned: readonly string[]): ModelInfo[] {
	const chosen = pinned
		.map((key) => models.find((model) => modelKey(model) === key))
		.filter((model): model is ModelInfo => model !== undefined);
	return [...chosen, ...models.filter((model) => !pinned.includes(modelKey(model)))];
}

/** Filter of the current provider's model list: id, name or provider contains the query. */
export function filterModels(models: readonly ModelInfo[], query: string): ModelInfo[] {
	const needle = query.trim().toLowerCase();
	return models.filter(
		(model) =>
			!needle ||
			model.id.toLowerCase().includes(needle) ||
			(model.name ?? "").toLowerCase().includes(needle) ||
			model.provider.toLowerCase().includes(needle),
	);
}

/** The provider id of the Step account's own catalog (`runtime.ts` registers it). */
export const STEP_MODEL_PROVIDER = "step";

/**
 * Whether a model comes from the Step account rather than a provider the user
 * configured in `models.json`. A Step Plan credential and custom providers can
 * both be configured, and they are different sources, not alternatives: the
 * panel lists them under their own headings instead of mixing one flat list.
 */
export function isStepModel(model: ModelInfo): boolean {
	return model.provider === STEP_MODEL_PROVIDER;
}

export interface ModelGroup {
	/** The provider every model in this section came from. */
	readonly provider: string;
	/** The provider's declared name; the section heading (the account's keeps its own label). */
	readonly name: string;
	/** `account` for Step's own catalog, `custom` for `models.json` providers. */
	readonly source: "account" | "custom";
	readonly models: ModelInfo[];
}

/**
 * Candidates partitioned by provider, the account's models first: one section
 * per provider instead of one flat list, so a gateway exposing hundreds of ids
 * never buries another provider's models.
 *
 * Custom providers keep catalog order (the order `models.json` declares them
 * in); the account's models come first because that is where a signed-in user
 * looks first.
 */
export function groupModelsByProvider(models: readonly ModelInfo[]): ModelGroup[] {
	const groups: ModelGroup[] = [];
	for (const model of models) {
		const existing = groups.find((group) => group.provider === model.provider);
		if (existing) {
			existing.models.push(model);
			continue;
		}
		groups.push({
			provider: model.provider,
			name: model.providerName || model.provider,
			source: isStepModel(model) ? "account" : "custom",
			models: [model],
		});
	}
	return [
		...groups.filter((group) => group.source === "account"),
		...groups.filter((group) => group.source === "custom"),
	];
}

/**
 * The section the panel's model list shows: the current model's provider, or
 * the first one (the account's) when no model is resolved yet. Undefined means
 * an empty catalog — the panel shows its empty state and the way to settings.
 */
export function currentProviderGroup(
	source: ModelSource,
	groups: readonly ModelGroup[] = groupModelsByProvider(source.models ?? []),
): ModelGroup | undefined {
	if (!groups.length) return undefined;
	return groups.find((group) => source.model !== undefined && group.provider === source.model.provider) ?? groups[0];
}
