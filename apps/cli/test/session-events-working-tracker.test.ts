import { describe, expect, test, vi } from "vitest";
import type { AssistantMessage } from "@step-harness/providers";
import { WorkingOutputTracker } from "../src/ui/view/chrome/status-indicator.ts";
import type { RuntimeContext } from "../src/ui/runtime/context.ts";
import { handleSessionEvent } from "../src/ui/runtime/session-events.ts";

test.each(["agent_end", "auto_clm_end", "compaction_end"] as const)(
	"clears terminal progress on %s even after the setting is disabled",
	async (type) => {
		const setProgress = vi.fn();
		const ctx = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { terminal: { setProgress } },
			clearStatusIndicator: vi.fn(),
			pendingTools: new Map(),
			redraw: { requestRender: vi.fn() },
			flushCompactionQueue: vi.fn(),
		} as unknown as RuntimeContext;
		if (type === "compaction_end") {
			await handleSessionEvent(ctx, { type, reason: "manual", result: undefined, aborted: false, willRetry: false });
		} else if (type === "agent_end") {
			await handleSessionEvent(ctx, { type, messages: [], willRetry: false });
		} else {
			await handleSessionEvent(ctx, {
				type,
				result: { attempted: true, accepted: false, fallback: false, reason: "aborted", requests: 0 },
			});
		}
		expect(setProgress).toHaveBeenCalledExactlyOnceWith(false);
	},
);

test("turn tips follow the current goal branch and respect the disabled setting", async () => {
	const now = new Date().toISOString();
	const goal = { id: "goal-1", sessionId: "session-1", objective: "Ship it", status: "active", createdAt: now, updatedAt: now };
	let branch = [{ type: "custom", customType: "step-goal", data: goal }];
	let enabled = true;
	const ctx = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		sessionManager: { getBranch: () => branch, getSessionId: () => "session-1" },
		settingsManager: { getStatusTips: () => enabled, getShowTerminalProgress: () => false },
		workingVisible: false,
		clearStatusIndicator: vi.fn(),
		redraw: { requestRender: vi.fn() },
	} as unknown as RuntimeContext;
	await handleSessionEvent(ctx, { type: "turn_start" });
	expect(ctx.currentStatusTip).toContain("/goal status");
	await handleSessionEvent(ctx, { type: "turn_start" });
	expect(ctx.currentStatusTip).toContain("/goal pause");
	branch = [{ ...branch[0], data: { ...goal, status: "paused" } }];
	await handleSessionEvent(ctx, { type: "turn_start" });
	expect(ctx.currentStatusTip).toContain("/goal resume");
	branch = [];
	await handleSessionEvent(ctx, { type: "turn_start" });
	expect(ctx.currentStatusTip).toContain("/theme");
	enabled = false;
	await handleSessionEvent(ctx, { type: "turn_start" });
	expect(ctx.currentStatusTip).toBeUndefined();
});

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
