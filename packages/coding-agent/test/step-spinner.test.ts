import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	STEP_SPINNER_FRAMES,
	STEP_SPINNER_INTERVAL_MS,
	StepToolSpinnerClock,
} from "../src/modes/interactive/components/step-spinner.ts";

describe("StepToolSpinnerClock", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test("shares one timer across tool calls and reports elapsed seconds", () => {
		const requestRender = vi.fn();
		const clock = new StepToolSpinnerClock(requestRender);
		clock.start("a");
		clock.start("b");

		expect(clock.frame).toBe(STEP_SPINNER_FRAMES[0]);
		expect(clock.elapsedSeconds("a")).toBe(0);
		vi.advanceTimersByTime(STEP_SPINNER_INTERVAL_MS);
		expect(clock.frame).toBe(STEP_SPINNER_FRAMES[1]);
		expect(requestRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1_000);
		expect(clock.elapsedSeconds("a")).toBe(1);
		expect(clock.elapsedSeconds("b")).toBe(1);

		clock.stop("a");
		const callsBeforeSecondStop = requestRender.mock.calls.length;
		vi.advanceTimersByTime(STEP_SPINNER_INTERVAL_MS);
		expect(requestRender.mock.calls.length).toBeGreaterThan(callsBeforeSecondStop);
		clock.stop("b");
		const callsAfterStop = requestRender.mock.calls.length;
		vi.advanceTimersByTime(STEP_SPINNER_INTERVAL_MS * 2);
		expect(requestRender).toHaveBeenCalledTimes(callsAfterStop);
		expect(clock.elapsedSeconds("a")).toBeNull();
	});

	test("dispose clears active rows and resets the frame", () => {
		const clock = new StepToolSpinnerClock(() => {});
		clock.start("a");
		vi.advanceTimersByTime(STEP_SPINNER_INTERVAL_MS * 2);
		expect(clock.frame).toBe(STEP_SPINNER_FRAMES[2]);
		clock.dispose();
		expect(clock.frame).toBe(STEP_SPINNER_FRAMES[0]);
		expect(clock.elapsedSeconds("a")).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});
});
