import assert from "node:assert/strict";
import test from "node:test";
import { clockTime, fullDateTime } from "../client/src/features/conversation/message-meta.ts";

test("a message time is shown as 24-hour HH:MM in local time", () => {
	const value = new Date(2026, 9, 22, 9, 5, 30);
	assert.equal(clockTime(value.toISOString()), "09:05");
	const evening = new Date(2026, 9, 22, 23, 59, 0);
	assert.equal(clockTime(evening.toISOString()), "23:59");
});

test("midnight is 00:00 rather than 24:00", () => {
	const midnight = new Date(2026, 9, 22, 0, 0, 0);
	assert.equal(clockTime(midnight.toISOString()), "00:00");
});

test("an unparseable timestamp is passed through instead of inventing a clock", () => {
	assert.equal(clockTime("not-a-date"), "not-a-date");
});

test("full message datetime uses the reader's zone with date and minute padding", () => {
	assert.equal(typeof fullDateTime, "function");
	const cases: readonly (readonly [Date, string])[] = [
		[new Date(2026, 0, 2, 3, 4, 59), "2026-01-02 03:04"],
		[new Date(2026, 11, 31, 23, 59), "2026-12-31 23:59"],
		[new Date(2027, 0, 1, 0, 0), "2027-01-01 00:00"],
	];
	for (const [date, expected] of cases) {
		assert.equal(fullDateTime(date.toISOString()), expected);
	}
});

test("full datetime converts an explicit offset to local time", () => {
	const value = "2026-10-26T00:12:00-05:00";
	const date = new Date(value);
	const pad = (number: number) => String(number).padStart(2, "0");
	assert.equal(
		fullDateTime(value),
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
	);
});

test("missing, invalid and ambiguous timestamps render nothing", () => {
	for (const value of [
		undefined,
		null,
		0,
		{},
		"",
		"not-a-date",
		"2026-02-30T09:00:00Z",
		"2026-10-26",
		"2026-10-26T09:00:00",
		"2026-13-01T00:00:00Z",
		"2026-01-01T24:00:00Z",
	]) {
		assert.equal(fullDateTime(value), "", String(value));
	}
});
