import { type ReactNode, useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { relativeTimeLong } from "../lib/format";
import { appStore, useAppStore } from "../state/store";
import { type Locale, MESSAGES, type MessageKey } from "./messages";

export { LOCALES, type Locale, type MessageKey, TAG_COLOR_NAMES, type TagColor } from "./messages";

export type TranslationValues = Readonly<Record<string, string | number>>;

/**
 * Look a key up for `locale`, falling back to zh-CN and then to the key itself,
 * and substitute `{name}` placeholders (legacy app.js `t`). Keys are typed as
 * plain strings because the legacy code also builds them dynamically
 * (`policy.${id}.label`, `feedbackTopic.${topic}`) and relies on the key
 * fallback to detect a missing translation.
 */
export function translate(locale: Locale, key: MessageKey | (string & {}), values: TranslationValues = {}): string {
	let text = MESSAGES[locale]?.[key] ?? MESSAGES["zh-CN"][key] ?? key;
	for (const [name, value] of Object.entries(values)) text = text.replace(`{${name}}`, String(value));
	return text;
}

/** Translate with the current store locale. Safe outside React (session.ts, actions). */
export function t(key: MessageKey | (string & {}), values?: TranslationValues): string {
	return translate(appStore.getState().locale, key, values);
}

/** t() with an explicit fallback, for strings the kernel already supplies (legacy `tOr`). */
export function tOr(key: string, fallback: string): string {
	const value = t(key);
	return value === key ? fallback : value;
}

export type TranslateFn = (key: MessageKey | (string & {}), values?: TranslationValues) => string;

/**
 * Translation function bound to the current locale. Components that call it
 * re-render when the locale changes, which replaces the legacy `applyLocale`
 * pass over `[data-i18n]` elements.
 */
export function useT(): TranslateFn {
	const locale = useAppStore((state) => state.locale);
	return useCallback((key, values) => translate(locale, key, values), [locale]);
}

/** Current locale, for components that branch on it directly. */
export function useLocale(): Locale {
	return useAppStore((state) => state.locale);
}

/** The Markdown renderer's labels in the current locale; one object per locale, so the renderer's memo holds. */
export function useMarkdownLabels(): {
	readonly code: string;
	readonly copy: string;
	readonly table: string;
	readonly diagram: string;
} {
	const locale = useLocale();
	return useMemo(
		() => ({
			code: translate(locale, "code"),
			copy: translate(locale, "copy"),
			table: translate(locale, "markdownTable"),
			diagram: translate(locale, "markdownDiagram"),
		}),
		[locale],
	);
}

/**
 * Short elapsed time for list rows: "39 分钟" / "20 小时" / "6 天" in Chinese,
 * "39m" / "20h" / "6d" in English; under a minute is "just now".
 */
export function formatRelativeTime(value: string | number | Date | undefined, now = Date.now()): string {
	const timestamp = new Date(value ?? Number.NaN).getTime();
	if (!Number.isFinite(timestamp)) return "";
	const elapsed = Math.max(0, now - timestamp);
	if (elapsed < 60_000) return t("justNow");
	if (elapsed < 3_600_000) return t("relativeTimeMinutes", { count: Math.floor(elapsed / 60_000) });
	if (elapsed < 86_400_000) return t("relativeTimeHours", { count: Math.floor(elapsed / 3_600_000) });
	return t("relativeTimeDays", { count: Math.floor(elapsed / 86_400_000) });
}

/** The spelled-out `relativeTimeLong` ("4 小时前") in the current locale. */
export function formatRelativeTimeLong(value: string | number | Date | undefined): string {
	return relativeTimeLong(value, appStore.getState().locale, t("justNow"));
}

/*
 * One shared 30-second clock for relative times. Without it a row keeps the
 * label from its last render, so the sidebar says "10m" while a freshly opened
 * search, reading the same timestamp, says "just now".
 */
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;
let clockNow = Date.now();
function subscribeClock(listener: () => void): () => void {
	clockListeners.add(listener);
	clockTimer ??= setInterval(() => {
		clockNow = Date.now();
		for (const notify of clockListeners) notify();
	}, 30_000);
	return () => {
		clockListeners.delete(listener);
		if (clockListeners.size === 0 && clockTimer !== undefined) {
			clearInterval(clockTimer);
			clockTimer = undefined;
		}
	};
}

/** Re-renders the caller as relative times age; pair it with `formatRelativeTime`. */
export function useRelativeTimeClock(): number {
	return useSyncExternalStore(subscribeClock, () => clockNow);
}

/**
 * Keeps `<html lang>` in step with the store locale. Persisting the choice is
 * `applyLocale` (features/shell/actions.ts); this only mirrors it into the DOM.
 */
export function I18nProvider({ children }: { readonly children: ReactNode }): ReactNode {
	const locale = useLocale();
	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);
	return children;
}
