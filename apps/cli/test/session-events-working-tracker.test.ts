import { describe, expect, test, vi } from "vitest";
import type { AssistantMessage } from "@step-harness/providers";
import { WorkingOutputTracker } from "../src/ui/view/chrome/status-indicator.ts";
import type { RuntimeContext } from "../src/ui/runtime/context.ts";
import { handleSessionEvent } from "../src/ui/runtime/session-events.ts";
import { INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE } from "@step-harness/coding-agent";

test("announces only a recovery that actually starts and uses its attempt metadata", async () => {
	const showStatus = vi.fn();
	const ctx = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		showStatus,
		addMessageToChat: vi.fn(),
		redraw: { requestRender: vi.fn() },
	} as unknown as RuntimeContext;
	await handleSessionEvent(ctx, {
		type: "message_start",
		message: { role: "custom", customType: "other", content: "", display: false, timestamp: 1 },
	});
	expect(showStatus).not.toHaveBeenCalled();
	await handleSessionEvent(ctx, {
		type: "message_start",
		message: {
			role: "custom",
			customType: INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
			content: "",
			display: false,
			timestamp: 2,
			details: { attempt: 2, maxAttempts: 3 },
		},
	});
	expect(showStatus).toHaveBeenCalledExactlyOnceWith("Retry attempt 2/3 started after an empty model turn.");
	expect(showStatus.mock.calls[0][0]).not.toContain("retrying");
});

test("settlement displays a final failure even when it equals the turn explanation", async () => {
	const showError = vi.fn();
	const ctx = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		showError,
		checkShutdownRequested: vi.fn(),
	} as unknown as RuntimeContext;
	const failure = {
		kind: "incomplete_turn" as const,
		reason: "no_visible_output" as const,
		message: "The model returned no visible answer or executable tool call.",
	};
	await handleSessionEvent(ctx, { type: "agent_settled", failure });
	expect(showError).toHaveBeenCalledExactlyOnceWith(failure.message);
	showError.mockClear();
	await handleSessionEvent(ctx, { type: "agent_settled" });
	expect(showError).not.toHaveBeenCalled();
});

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

test("restores the working indicator when compaction ends inside an active agent run", async () => {
	const showWorkingStatusIndicator = vi.fn();
	const createContext = (isStreaming: boolean) =>
		({
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { terminal: { setProgress: vi.fn() } },
			session: { agent: { state: { isStreaming } } },
			workingVisible: true,
			activeStatusIndicator: undefined,
			showWorkingStatusIndicator,
			clearStatusIndicator: vi.fn(),
			redraw: { requestRender: vi.fn() },
			flushCompactionQueue: vi.fn(),
		}) as unknown as RuntimeContext;
	await handleSessionEvent(createContext(true), {
		type: "compaction_end",
		reason: "threshold",
		result: undefined,
		aborted: false,
		willRetry: false,
	});
	await handleSessionEvent(createContext(true), {
		type: "auto_clm_end",
		result: { attempted: true, accepted: false, fallback: false, reason: "no-edit", requests: 1 },
	});
	expect(showWorkingStatusIndicator).toHaveBeenCalledTimes(2);
	// An idle session (pre-prompt compaction or /compact) must not show a working indicator.
	await handleSessionEvent(createContext(false), {
		type: "compaction_end",
		reason: "manual",
		result: undefined,
		aborted: false,
		willRetry: false,
	});
	expect(showWorkingStatusIndicator).toHaveBeenCalledTimes(2);
});

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
