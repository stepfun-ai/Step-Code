import { describe, expect, test } from "vitest";
import { formatElapsedTime } from "../src/utils/time.ts";

describe("formatElapsedTime", () => {
	test("scales seconds to minutes and hours", () => {
		expect(formatElapsedTime(0)).toBe("0s");
		expect(formatElapsedTime(45)).toBe("45s");
		expect(formatElapsedTime(59)).toBe("59s");
		expect(formatElapsedTime(60)).toBe("1m");
		expect(formatElapsedTime(90)).toBe("1m 30s");
		expect(formatElapsedTime(3505)).toBe("58m 25s");
		expect(formatElapsedTime(3600)).toBe("1h");
		expect(formatElapsedTime(3720)).toBe("1h 02m");
	});
});
