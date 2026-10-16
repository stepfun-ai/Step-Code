import { afterEach, expect, test, vi } from "vitest";
import { rateLimitDelay } from "../src/core/rate-limit.ts";
import { sleep } from "../src/utils/sleep.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("429 delay honors server hints instead of capping them to local backoff", () => {
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	expect(rateLimitDelay(1)).toBe(875);
	expect(rateLimitDelay(2)).toBe(1750);
	expect(rateLimitDelay(20)).toBeLessThanOrEqual(30_000);
	expect(rateLimitDelay(1, 90_000)).toBe(90_000);
});

test("a long Retry-After does not overflow into an immediate retry and remains cancellable", async () => {
	vi.useFakeTimers();
	const controller = new AbortController();
	const waiting = sleep(3_000_000_000, controller.signal);
	const rejected = expect(waiting).rejects.toThrow("Aborted");
	await vi.advanceTimersByTimeAsync(1000);
	expect(vi.getTimerCount()).toBe(1);
	controller.abort();
	await rejected;
	expect(vi.getTimerCount()).toBe(0);
});
