/** Pure recorded-time formatting shared by transcript metadata and child input receipts. */

/** `YYYY-MM-DD HH:mm` in the reader's zone; missing or invalid recorded datetimes have no label. */
export function fullDateTime(value: unknown): string {
	if (typeof value !== "string") return "";
	// Require a recorded instant with a zone, not a browser-dependent date interpretation.
	const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
	if (!parts) return "";
	const [, year, month, day, hour, minute, second] = parts.map(Number);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59)
		return "";
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return "";
	const pad = (number: number) => String(number).padStart(2, "0");
	return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `HH:MM` in the reader's own zone; an unparseable value passes through unchanged. */
export function clockTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
