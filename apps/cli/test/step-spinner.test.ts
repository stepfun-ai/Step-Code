import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	STEP_SPINNER_FRAMES,
	STEP_SPINNER_INTERVAL_MS,
	StepToolSpinnerClock,
} from "../src/ui/view/transcript/step-spinner.ts";

describe("StepToolSpinnerClock", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test("uses a 200ms animation cadence for long-running Step work", () => {
		expect(STEP_SPINNER_INTERVAL_MS).toBe(200);
	});

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

	test("pauses animation and excludes approval wait from displayed execution time", () => {
		const requestRender = vi.fn();
		const clock = new StepToolSpinnerClock(requestRender);
		clock.start("a", "run_command");
		vi.advanceTimersByTime(1_200);
		clock.setPaused(true);
		clock.setPaused(true);
		const frame = clock.frame;
		const renders = requestRender.mock.calls.length;

		vi.advanceTimersByTime(30_000);
		expect(clock.frame).toBe(frame);
		expect(clock.elapsedSeconds("a")).toBe(1);
		expect(clock.currentToolName()).toBe("run_command");
		expect(requestRender).toHaveBeenCalledTimes(renders);
		expect(vi.getTimerCount()).toBe(0);

		clock.setPaused(false);
		clock.setPaused(false);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(1_000);
		expect(clock.elapsedSeconds("a")).toBe(2);
		clock.dispose();
	});

	test("keeps tools started or cleared during approval paused until it ends", () => {
		const clock = new StepToolSpinnerClock(vi.fn());
		clock.setPaused(true);
		vi.advanceTimersByTime(5_000);
		clock.start("a", "run_command");
		vi.advanceTimersByTime(5_000);
		expect(clock.elapsedSeconds("a")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		clock.clear();
		expect(clock.elapsedSeconds("a")).toBeNull();
		expect(clock.currentToolName()).toBeUndefined();
		clock.start("b", "write_file");
		vi.advanceTimersByTime(10_000);
		expect(clock.elapsedSeconds("b")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		clock.setPaused(false);
		vi.advanceTimersByTime(1_000);
		expect(clock.elapsedSeconds("b")).toBe(1);
		clock.stop("b");
		expect(clock.frame).toBe(STEP_SPINNER_FRAMES[0]);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("does not restart disposed rows when an approval finishes late", () => {
		const clock = new StepToolSpinnerClock(vi.fn());
		clock.start("a");
		clock.setPaused(true);
		clock.dispose();
		clock.setPaused(false);
		expect(clock.elapsedSeconds("a")).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
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
