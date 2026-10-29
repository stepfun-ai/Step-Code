/**
 * Pure formatting helpers ported from legacy app.js. None of them reads app
 * state; strings that were translated in the legacy code are parameters here
 * (see i18n/index.ts for `formatRelativeTimeLong`, which supplies them).
 */

import type { ToolArgs } from "../state/types";

/** Collapse whitespace and cut to `limit` characters with an ellipsis (legacy `compact`). */
export function compact(value: unknown, limit = 120): string {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Fields that name a structured argument for a reader, in preference order. */
const READABLE_FIELDS = ["label", "title", "question", "subject", "description", "prompt", "name", "id"];

/**
 * A structured argument as words: an object by its first readable field, a list by its first
 * item (plus how many follow). Raw JSON in a one-line row is unreadable; the details keep it whole.
 */
function readableArg(value: unknown): string {
	if (Array.isArray(value)) {
		if (!value.length) return "[]";
		const first = readableArg(value[0]);
		return value.length > 1 ? `${first} +${value.length - 1}` : first;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const field = READABLE_FIELDS.find((key) => typeof record[key] === "string" && record[key]);
		return field ? String(record[field]) : "{…}";
	}
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** One-line `key=value` summary of a tool's arguments (legacy `toolInputSummary`). */
export function toolInputSummary(input: unknown): string {
	if (!input || typeof input !== "object") return "无输入摘要";
	return compact(
		Object.entries(input as Record<string, unknown>)
			.map(([key, value]) => `${key}=${readableArg(value)}`)
			.join(" "),
	);
}

/** The arguments a tool row shows by name; undefined when the call has none of them. */
export function toolArgs(input: unknown): ToolArgs | undefined {
	if (!input || typeof input !== "object") return undefined;
	const raw = input as Record<string, unknown>;
	const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
	const path = text(raw.path) ?? text(raw.file_path);
	const command = text(raw.command);
	const pattern = text(raw.pattern);
	const offset = typeof raw.offset === "number" && Number.isFinite(raw.offset) ? raw.offset : undefined;
	if (path === undefined && command === undefined && pattern === undefined) return undefined;
	return {
		...(path !== undefined ? { path } : {}),
		...(command !== undefined ? { command } : {}),
		...(pattern !== undefined ? { pattern } : {}),
		...(offset !== undefined ? { offset } : {}),
	};
}

/** Longest tool input or output kept for the expanded row; the rest is cut so a huge result cannot stall the page. */
export const TOOL_DETAIL_LIMIT = 20_000;

/** Cut `text` to TOOL_DETAIL_LIMIT characters, saying how much was dropped. */
export function clipDetail(text: string): string {
	return text.length > TOOL_DETAIL_LIMIT
		? `${text.slice(0, TOOL_DETAIL_LIMIT)}\n… (${text.length - TOOL_DETAIL_LIMIT} more characters)`
		: text;
}

/** A tool's arguments in full, one `key: value` per line, for the expanded tool row. */
export function toolInputDetail(input: unknown): string {
	if (input === undefined || input === null) return "";
	if (typeof input !== "object") return clipDetail(String(input));
	return clipDetail(
		Object.entries(input as Record<string, unknown>)
			.map(([key, value]) => {
				if (typeof value !== "string") return `${key}: ${JSON.stringify(value, null, 2)}`;
				return value.includes("\n") ? `${key}:\n${value}` : `${key}: ${value}`;
			})
			.join("\n"),
	);
}

/**
 * Last path segment, accepting `/` and `\` (legacy `basename`). An empty path
 * yields "最近" exactly as the legacy code did; callers that need a neutral
 * placeholder check for an empty path first.
 */
export function basename(path: string | undefined | null): string {
	if (!path) return "最近";
	return (
		path
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.at(-1) || path
	);
}

/** Elapsed time spelled out in `locale`: "4 小时前" / "4 hours ago"; under a minute is `justNowLabel`. */
export function relativeTimeLong(
	value: string | number | Date | undefined,
	locale: string,
	justNowLabel: string,
	now = Date.now(),
): string {
	const timestamp = new Date(value ?? Number.NaN).getTime();
	if (!Number.isFinite(timestamp)) return "";
	const elapsed = Math.max(0, now - timestamp);
	if (elapsed < 60_000) return justNowLabel;
	const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	if (elapsed < 3_600_000) return format.format(-Math.floor(elapsed / 60_000), "minute");
	if (elapsed < 86_400_000) return format.format(-Math.floor(elapsed / 3_600_000), "hour");
	return format.format(-Math.floor(elapsed / 86_400_000), "day");
}

/** 45.9K rather than 45900 and 118.6M rather than 118627K, so a row stays one line. */
export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	const kilo = count / 1000;
	if (kilo < 999.5) return `${kilo >= 100 ? Math.round(kilo) : kilo.toFixed(1)}K`;
	const mega = count / 1_000_000;
	return `${mega >= 100 ? Math.round(mega) : mega.toFixed(1)}M`;
}

/** `512 B` / `1.5 KB` / `2.0 MB` (legacy `formatBytes`). */
export function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** Directory paths from the root down to the parent of `path` (legacy `ancestorPaths`). */
export function ancestorPaths(path: string): string[] {
	const parts = path.split("/");
	return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
}

/** Join class names, skipping falsy entries. */
export function cx(...names: Array<string | false | null | undefined>): string {
	return names.filter(Boolean).join(" ");
}

/** True on macOS, used for shortcut labels (legacy `navigator.platform.startsWith("Mac")`). */
export function isMacPlatform(): boolean {
	return typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
}
