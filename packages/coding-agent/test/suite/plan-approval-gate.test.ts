import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/** Record the request the model actually received. */
function record(requests: string[][]) {
	return (context: { messages: readonly unknown[] }) => {
		requests.push(context.messages.map((message) => JSON.stringify(message)));
		return fauxAssistantMessage("recorded");
	};
}

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

async function createPlanHarness(prefix: string, bindings?: Parameters<Harness["session"]["bindExtensions"]>[0]) {
	const storage = mkdtempSync(join(tmpdir(), prefix));
	roots.push(storage);
	const harness = await createHarness({
		bindings,
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
});

test("a caller handoff leaves the decision pending across a reload", async () => {
	// A handoff that leaves the mode still has an unanswered proposal, and the
	// guard must keep holding automatic work after the extension generation is
	// replaced: only the answer clears it.
	const { harness, planPath } = await createPlanHarness("step-plan-gate-resume-");
	await handoff(harness, planPath);
	const planEntry = harness.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === "step-plan" ? [(entry as { data?: unknown }).data] : [],
		)
		.at(-1);
	// The handoff left the mode but the proposal is still unanswered, so the fact
	// survives with `enabled: false` — that is what keeps the guard holding.
	expect(planEntry).toMatchObject({ enabled: false, pendingProposalHash: expect.any(String) });

	// The reload replaces the extension generation and replays the branch, so the
	// new guard has to read the wait back from the entry rather than from memory.
	harness.setResponses([fauxAssistantMessage("after reload")]);
	await harness.session.reload();
	expect(harness.session.hasPendingUserDecision).toBe(true);
});

test("notes sent mid-run reach the model as they are, with no second message", async () => {
	// The revision is one message: the user's notes. A hidden companion could not
	// be kept in the same request, and would tell the model to resubmit before it
	// had read what to change.
	const { harness, planPath } = await createPlanHarness("step-plan-gate-revision-", {
		mode: "rpc",
		planReviewSurface: true,
	});
	mkdirSync(dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Proposal\nDo it.\n");
	const requests: string[][] = [];
	harness.setResponses([fauxAssistantMessage([fauxToolCall("exit_plan_mode", {})])]);
	await harness.session.prompt("/plan write the proposal");
	expect(harness.session.hasPendingUserDecision).toBe(true);

	harness.setResponses([record(requests)]);
	await harness.session.prompt("/plan split the second step");

	const request = requests.at(-1) ?? [];
	// The notes are the whole message: they arrive as the user's own text and are
	// the last thing the model sees, with no hidden instruction appended after them.
	expect(request.at(-1)).toContain("split the second step");
});

test("a change request queued before the submission still reaches the model", async () => {
	// The user typed these words, and the turn they waited behind is the one that
	// submitted the proposal. Holding the queue back would leave their request
	// behind a gate only they can open, with nothing on screen to open it.
	const { harness, planPath } = await createPlanHarness("step-plan-gate-notes-", {
		mode: "rpc",
		planReviewSurface: true,
	});
	mkdirSync(dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Proposal\nDo it.\n");
	const requests: string[][] = [];
	harness.setResponses([
		async () => {
			await harness.session.sendUserMessage("split the second step", {
				deliverAs: "followUp",
				source: "rpc",
			});
			return fauxAssistantMessage([fauxToolCall("exit_plan_mode", {})]);
		},
		record(requests),
		record(requests),
	]);
	await harness.session.prompt("/plan write the proposal");

	// The submission armed the gate: the proposal is waiting for an answer.
	expect(harness.session.hasPendingUserDecision).toBe(true);
	// Their words are the input of the next request, not something the model is
	// asked about and told afterwards: the turn that submits ends, and the message
	// it held enters before the model is asked anything.
	expect(requests).toHaveLength(1);
	expect(requests[0]?.at(-1)).toContain("split the second step");
});

test("automatic work queued ahead of the user's words is still held", async () => {
	// A continuation delivers one queued message at a time. Letting it run because
	// the user said something later would deliver the automatic work first, on
	// their behalf, past a decision they have not answered.
	const { harness, planPath } = await createPlanHarness("step-plan-gate-auto-", {
		mode: "rpc",
		planReviewSurface: true,
	});
	mkdirSync(dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Proposal\nDo it.\n");
	const requests: string[][] = [];
	harness.setResponses([
		async () => {
			await harness.session.sendCustomMessage(
				{ customType: "test-wake", content: "AUTOWORK", display: true, details: {} },
				{ deliverAs: "followUp", triggerTurn: true },
			);
			await harness.session.sendUserMessage("split the second step", {
				deliverAs: "followUp",
				source: "rpc",
			});
			return fauxAssistantMessage([fauxToolCall("exit_plan_mode", {})]);
		},
		record(requests),
		record(requests),
	]);
	await harness.session.prompt("/plan write the proposal");

	expect(harness.session.hasPendingUserDecision).toBe(true);
	// Their notes still get through — they are the answer the gate is waiting for.
	expect(requests.some((request) => request.some((message) => message.includes("split the second step")))).toBe(true);
	// The automatic work queued ahead of them does not, even though the turn that
	// would deliver it is the one their notes justified.
	expect(requests.some((request) => request.some((message) => message.includes("AUTOWORK")))).toBe(false);
});

test("work held by the decision is delivered once it is answered", async () => {
	// Holding is not dropping: the automatic work queued before the decision must
	// still run after the user answers, in one piece.
	const { harness, planPath } = await createPlanHarness("step-plan-gate-held-", {
		mode: "rpc",
		planReviewSurface: true,
	});
	mkdirSync(dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Proposal\nDo it.\n");
	const requests: string[][] = [];
	harness.setResponses([
		async () => {
			await harness.session.sendCustomMessage(
				{ customType: "test-wake", content: "AUTOWORK", display: true, details: {} },
				{ deliverAs: "followUp", triggerTurn: true },
			);
			return fauxAssistantMessage([fauxToolCall("exit_plan_mode", {})]);
		},
		record(requests),
	]);
	await harness.session.prompt("/plan write the proposal");

	// The submission holds the automatic work: it reached no request.
	expect(harness.session.hasPendingUserDecision).toBe(true);
	expect(requests.some((request) => request.some((message) => message.includes("AUTOWORK")))).toBe(false);

	// Answering releases it. The approval turn runs first, then the work it held.
	harness.setResponses([fauxAssistantMessage("implementing"), record(requests), record(requests)]);
	await harness.session.prompt("/plan approve");
	expect(harness.session.hasPendingUserDecision).toBe(false);
	expect(requests.some((request) => request.some((message) => message.includes("AUTOWORK")))).toBe(true);
});

test("a caller handoff is settled by the message that answers it, at delivery", async () => {
	// The message arrives through the queue, not through a new `prompt`: nothing
	// runs `before_agent_start`, so the delivery itself has to settle the wait.
	const { harness, planPath } = await createPlanHarness("step-plan-gate-delivery-", { mode: "rpc" });
	mkdirSync(dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Proposal\nDo it.\n");
	const requests: string[][] = [];
	harness.setResponses([
		async () => {
			await harness.session.sendUserMessage("Approved, go ahead.", { deliverAs: "followUp", source: "rpc" });
			return fauxAssistantMessage([fauxToolCall("exit_plan_mode", {})]);
		},
		record(requests),
	]);
	await harness.session.prompt("/plan write the proposal");

	// Their words are the input of the next request, not a request the model takes
	// before seeing them, and they settle the wait.
	expect(requests).toHaveLength(1);
	expect(requests[0]?.some((message) => message.includes("Approved, go ahead."))).toBe(true);
	expect(harness.session.hasPendingUserDecision).toBe(false);
});

test("a custom message held by the decision is not folded into the user's question", async () => {
	// Context an extension queued is not something the person wrote. It waits for the
	// turn that answers the decision, even when that turn is a question: the model
	// must not read automatic work past a decision that is still open.
	const { harness, planPath } = await createPlanHarness("step-plan-gate-custom-", {
		mode: "rpc",
		planReviewSurface: true,
	});
	mkdirSync(dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Proposal\nDo it.\n");
	harness.setResponses([fauxAssistantMessage([fauxToolCall("exit_plan_mode", {})])]);
	await harness.session.prompt("/plan write the proposal");
	expect(harness.session.hasPendingUserDecision).toBe(true);

	await harness.session.sendCustomMessage(
		{ customType: "test-wake", content: "AUTOWORK", display: true, details: {} },
		{ deliverAs: "followUp", triggerTurn: true },
	);

	const requests: string[][] = [];
	harness.setResponses([record(requests)]);
	await harness.session.prompt("why the second step?");
	expect(requests).toHaveLength(1);
	expect(requests[0]?.some((message) => message.includes("AUTOWORK"))).toBe(false);
});

test("notes forwarded by a command still answer the decision they queued behind", async () => {
	// `/plan <notes>` is the user's own words, forwarded by a command. The session
	// tracks who typed it, so the note may answer the wait it queued behind instead
	// of being held as extension traffic — otherwise a user asking for changes would
	// have them silently dropped.
	const { harness, planPath } = await createPlanHarness("step-plan-gate-command-notes-", {
		mode: "rpc",
		planReviewSurface: true,
	});
	mkdirSync(dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Proposal\nDo it.\n");
	const requests: string[][] = [];
	harness.setResponses([
		async () => {
			// Queued during the turn that submits, through the command path (`/plan`).
			await harness.session.prompt("/plan split the second step");
			return fauxAssistantMessage([fauxToolCall("exit_plan_mode", {})]);
		},
		record(requests),
		record(requests),
	]);
	await harness.session.prompt("/plan write the proposal");

	expect(harness.session.hasPendingUserDecision).toBe(true);
	expect(requests).toHaveLength(1);
	expect(requests[0]?.at(-1)).toContain("split the second step");
});

test("a compaction does not leave a decision nobody can answer", async () => {
	const { harness, planPath } = await createPlanHarness("step-plan-gate-compact-");
	await handoff(harness, planPath);
	expect(harness.session.hasPendingUserDecision).toBe(true);

	// The decision waits in the `step-plan` entry, not in the summarized history,
	// so compaction changes neither answer nor wait. What must not happen is a
	// decided proposal coming back after a summary.
	const firstMessage = harness.sessionManager.getBranch().find((entry) => entry.type === "message");
	expect(firstMessage).toBeDefined();
	harness.sessionManager.appendCompaction("Earlier work summarized.", firstMessage!.id, 1_000);
	expect(harness.session.hasPendingUserDecision).toBe(true);

	harness.setResponses([fauxAssistantMessage("implemented")]);
	await harness.session.prompt("Approved.");
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
