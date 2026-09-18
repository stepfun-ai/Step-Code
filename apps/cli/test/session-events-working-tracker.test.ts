import { describe, expect, test, vi } from "vitest";
import type { AssistantMessage } from "@step-harness/providers";
import { WorkingOutputTracker } from "../src/ui/view/chrome/status-indicator.ts";
import type { RuntimeContext } from "../src/ui/runtime/context.ts";
import { handleSessionEvent } from "../src/ui/runtime/session-events.ts";

/**
 * agent_start must only zero the working tracker for a genuinely new prompt.
 * A retry continuation (retryAttempt > 0) fires agent_start again after a
 * 502/timeout recovers, and the elapsed/token readout has to keep accumulating
 * instead of restarting from zero.
 */
describe("session-events agent_start working-tracker reset", () => {
	function createContext(tracker: WorkingOutputTracker, retryAttempt: number): RuntimeContext {
		return {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			presentation: "step",
			session: { retryAttempt },
			workingOutputTracker: tracker,
			turnEndedAbnormally: false,
			pendingTools: new Map(),
			stepSpinner: undefined,
			retryEscapeHandler: undefined,
			defaultEditor: {},
		} as unknown as RuntimeContext;
	}

	function completeWith(tracker: WorkingOutputTracker, outputTokens: number): void {
		tracker.complete({ usage: { output: outputTokens } } as AssistantMessage);
	}

	test("resets elapsed/token counters on a genuinely new prompt", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const tracker = new WorkingOutputTracker();

			await handleSessionEvent(createContext(tracker, 0), { type: "agent_start" });
			completeWith(tracker, 100);
			vi.advanceTimersByTime(5_000);
			expect(tracker.snapshot().outputTokens).toBe(100);
			expect(tracker.snapshot().elapsedSeconds).toBe(5);

			// A later, unrelated prompt must start counting from zero again.
			await handleSessionEvent(createContext(tracker, 0), { type: "agent_start" });
			expect(tracker.snapshot().outputTokens).toBe(0);
			expect(tracker.snapshot().elapsedSeconds).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("accumulates elapsed/token counters across a retry continuation", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const tracker = new WorkingOutputTracker();

			await handleSessionEvent(createContext(tracker, 0), { type: "agent_start" });
			completeWith(tracker, 100);
			vi.advanceTimersByTime(5_000);
			expect(tracker.snapshot().outputTokens).toBe(100);
			expect(tracker.snapshot().elapsedSeconds).toBe(5);

			// Upstream returned 502 and the outer retry kicked in: agent_start fires
			// again while the retry is still in flight. Counting must CONTINUE.
			await handleSessionEvent(createContext(tracker, 1), { type: "agent_start" });
			expect(tracker.snapshot().outputTokens).toBe(100);
			expect(tracker.snapshot().elapsedSeconds).toBe(5);
		} finally {
			vi.useRealTimers();
		}
	});
});
