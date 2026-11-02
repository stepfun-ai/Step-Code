import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AgentSessionRuntimeHost } from "../../src/core/agent-session-runtime.ts";
import * as output from "../../src/core/output-guard.ts";
import { createStepPlanExtension } from "../../src/features/step-plan.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createStepToolProfile } from "../../src/step/tool-profile.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const roots: string[] = [];

beforeEach(() => {
	initTheme("dark");
	vi.spyOn(output, "writeRawStdout").mockImplementation(() => {});
	vi.spyOn(output, "waitForRawStdoutBackpressure").mockResolvedValue();
	vi.spyOn(output, "flushRawStdout").mockResolvedValue();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function printHost(harness: Harness): AgentSessionRuntimeHost {
	return {
		session: harness.session,
		cwd: harness.tempDir,
		setRebindSession: vi.fn(),
		newSession: vi.fn(async () => ({ cancelled: false })),
		fork: vi.fn(async () => ({ cancelled: false })),
		switchSession: vi.fn(async () => ({ cancelled: false })),
		// The run ends, but these tests keep inspecting the settled session: the
		// harness cleans it up.
		dispose: async () => {},
	} as unknown as AgentSessionRuntimeHost;
}

async function createPlanHarness(prefix: string) {
	const storage = mkdtempSync(join(tmpdir(), prefix));
	roots.push(storage);
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				for (const tool of createStepToolProfile(process.cwd(), { agentDir: join(storage, "agent") })) {
					if (["read_file", "write_file", "edit_file"].includes(tool.name)) pi.registerTool(tool);
				}
			},
			createStepPlanExtension(),
		],
	});
	harnesses.push(harness);
	vi.stubEnv("STEP_CODING_AGENT_PLAN_DIR", join(storage, "plans"));
	const planPath = join(storage, "plans", `session-${harness.session.sessionId}.md`);
	return { harness, planPath };
}

/**
 * Hand the plan to the caller and settle.
 *
 * `runPrintMode` has no user behind the review dialog, so the plan extension
 * exits plan mode and ends the turn: exactly the state an automatic turn starter
 * must not continue.
 */
async function handoff(harness: Harness, planPath: string): Promise<void> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("write_file", { path: planPath, content: "# Proposal\nDo it.\n" })]),
		fauxAssistantMessage([fauxToolCall("exit_plan_mode", {})]),
		fauxAssistantMessage("unused"),
	]);
	await harness.session.prompt("/plan");
	expect(
		await runPrintMode(printHost(harness), {
			mode: "json",
			initialMessage: "Plan the change.",
		}),
	).toBe(0);
}

test("an automatic turn starter waits for the answered decision", async () => {
	const { harness, planPath } = await createPlanHarness("step-plan-gate-");
	await handoff(harness, planPath);
	expect(harness.session.hasPendingUserDecision).toBe(true);
	const callsBefore = harness.faux.state.callCount;

	// Goal continuation, cron delivery, and a background lane waking its parent
	// all reach a turn through this call.
	await harness.session.sendCustomMessage(
		{ customType: "test-wake", content: "continue the work", display: true, details: {} },
		{ deliverAs: "followUp", triggerTurn: true },
	);
	expect(harness.faux.state.callCount).toBe(callsBefore);

	// The user's own message is the approval: it runs, and it clears the gate.
	harness.setResponses([fauxAssistantMessage("implemented")]);
	await harness.session.prompt("Approved, go ahead.");
	expect(harness.session.hasPendingUserDecision).toBe(false);
	expect(harness.faux.state.callCount).toBeGreaterThan(callsBefore);
});

test("an extension user message does not start a turn past the decision", async () => {
	const { harness, planPath } = await createPlanHarness("step-plan-gate-ext-");
	await handoff(harness, planPath);
	const callsBefore = harness.faux.state.callCount;

	await harness.session.sendUserMessage("keep going");
	expect(harness.faux.state.callCount).toBe(callsBefore);
	expect(harness.session.pendingMessageCount).toBeGreaterThan(0);

	harness.setResponses([fauxAssistantMessage("implemented")]);
	await harness.session.prompt("Approved.");
	expect(harness.faux.state.callCount).toBeGreaterThan(callsBefore);
});

test("the handoff text reaches a headless text caller", async () => {
	const { harness, planPath } = await createPlanHarness("step-plan-gate-text-");
	const stdout: string[] = [];
	vi.spyOn(output, "writeRawStdout").mockImplementation((chunk) => {
		stdout.push(chunk);
	});
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("write_file", { path: planPath, content: "# Proposal\nDo it.\n" })]),
		fauxAssistantMessage([fauxToolCall("exit_plan_mode", {})]),
	]);
	await harness.session.prompt("/plan");
	expect(await runPrintMode(printHost(harness), { mode: "text", initialMessage: "Plan it." })).toBe(0);
	expect(stdout.join("")).toContain("# Proposal");
});

test("a reload does not leave an automatic-turn guard stranded", async () => {
	const { harness, planPath } = await createPlanHarness("step-plan-gate-reload-");
	await handoff(harness, planPath);
	expect(harness.session.hasPendingUserDecision).toBe(true);

	harness.setResponses([fauxAssistantMessage("implemented")]);
	await harness.session.prompt("Approved.");
	expect(harness.session.hasPendingUserDecision).toBe(false);

	// Reload replaces the extension runner but keeps the session. Guards hold the
	// runner's context, so a stale one would throw on every read and look like a
	// permanent pending decision.
	harness.setResponses([fauxAssistantMessage("after reload")]);
	await harness.session.reload();
	expect(harness.session.hasPendingUserDecision).toBe(false);

	// The new generation registers its own guard: an unanswered handoff on the
	// restored branch is gated again. The handoff is appended directly because the
	// reload also drops the test provider registration.
	harness.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "plan-after-reload",
		toolName: "exit_plan_mode",
		content: [{ type: "text", text: "Caller must approve." }],
		details: { outcome: "external_approval_required" },
		isError: false,
		timestamp: Date.now(),
	} as unknown as Parameters<typeof harness.sessionManager.appendMessage>[0]);
	expect(harness.session.hasPendingUserDecision).toBe(true);

	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Approved." }],
		timestamp: Date.now(),
	} as unknown as Parameters<typeof harness.sessionManager.appendMessage>[0]);
	expect(harness.session.hasPendingUserDecision).toBe(false);
});

test("a compaction ends the wait instead of leaving a phantom decision", async () => {
	const { harness, planPath } = await createPlanHarness("step-plan-gate-compact-");
	await handoff(harness, planPath);
	expect(harness.session.hasPendingUserDecision).toBe(true);

	// The summary replaces the history that held the handoff, so it is no longer
	// something the user can answer. Leaving the gate closed would stall goal,
	// cron, and lane wake-ups with nothing to answer.
	const firstMessage = harness.sessionManager.getBranch().find((entry) => entry.type === "message");
	expect(firstMessage).toBeDefined();
	harness.sessionManager.appendCompaction("Earlier work summarized.", firstMessage!.id, 1_000);
	expect(harness.session.hasPendingUserDecision).toBe(false);
});

test("a blocked trigger stays visible in the queue ledger", async () => {
	const { harness, planPath } = await createPlanHarness("step-plan-gate-ledger-");
	await handoff(harness, planPath);
	const before = harness.session.pendingMessageCount;

	await harness.session.sendCustomMessage(
		{ customType: "test-wake", content: "continue", display: false, details: {} },
		{ deliverAs: "followUp", triggerTurn: true },
	);
	// The message is not lost in a queue the session cannot see: it is pending,
	// and the answering turn carries it as context.
	expect(harness.session.pendingMessageCount).toBe(before + 1);

	harness.setResponses([fauxAssistantMessage("implemented")]);
	await harness.session.prompt("Approved.");
	expect(harness.session.pendingMessageCount).toBe(0);
	expect(
		harness.session.messages.some(
			(message) => message.role === "custom" && (message as { customType?: string }).customType === "test-wake",
		),
	).toBe(true);
});
