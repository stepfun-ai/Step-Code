import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { createHarness, getMessageText, type Harness } from "./harness.ts";

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

async function setup() {
	const storage = mkdtempSync(join(tmpdir(), "step-plan-barrier-"));
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
	const run = async () => {
		const host = {
			session: harness.session,
			cwd: harness.tempDir,
			setRebindSession: vi.fn(),
			newSession: vi.fn(async () => ({ cancelled: false })),
			fork: vi.fn(async () => ({ cancelled: false })),
			switchSession: vi.fn(async () => ({ cancelled: false })),
			dispose: async () => {
				await harness.session.abort();
				await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				harness.session.dispose();
			},
		};
		await harness.session.prompt("/plan");
		return runPrintMode(host as unknown as AgentSessionRuntimeHost, {
			mode: "json",
			initialMessage: "Plan the change.",
		});
	};
	return { harness, planPath, run };
}

test("a decision barrier closes the rest of its batch before those calls run", async () => {
	const { harness, planPath, run } = await setup();
	const target = join(harness.tempDir, "src", "app.ts");
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("write_file", { path: planPath, content: "# Proposal\nDo it.\n" })]),
		// One assistant message asks for the handoff and an edit at once. The
		// sequential barrier must close the batch, not run the edit behind it.
		fauxAssistantMessage([
			fauxToolCall("exit_plan_mode", {}),
			fauxToolCall("write_file", { path: target, content: "export const changed = true;\n" }),
		]),
		fauxAssistantMessage("must not be used"),
	]);

	expect(await run()).toBe(0);

	const ends = harness.eventsOfType("tool_execution_end");
	expect(ends.map((event) => [event.toolName, event.isError])).toEqual([
		["write_file", false],
		["exit_plan_mode", false],
		["write_file", true],
	]);
	// The skipped call is reported as an error so the protocol stays complete, but
	// it is not a policy denial: no `terminate` for callers that map that to a
	// failed run.
	expect(getMessageText(ends[2]!.result)).toContain("skipped");
	expect((ends[2]!.result as { terminate?: boolean }).terminate).toBeUndefined();
	expect(existsSync(target)).toBe(false);
	// One model turn produced both calls; the barrier ends the run instead of
	// spending a request on the next assistant message.
	expect(harness.faux.state.callCount).toBe(2);
	expect(readFileSync(planPath, "utf8")).toBe("# Proposal\nDo it.\n");
});

test("plan mode blocks a fused then_run command", async () => {
	const { harness, planPath, run } = await setup();
	const outside = join(harness.tempDir, "src", "app.ts");
	harness.setResponses([
		fauxAssistantMessage([
			fauxToolCall("write_file", { path: planPath, content: "# Proposal\nDo it.\n", then_run: `touch ${outside}` }),
		]),
		fauxAssistantMessage([fauxToolCall("write_file", { path: outside, content: "x", then_run: "touch marker" })]),
		fauxAssistantMessage("Plan written."),
	]);

	expect(await run()).toBe(0);

	const ends = harness.eventsOfType("tool_execution_end");
	expect(ends[0]).toMatchObject({ toolName: "write_file" });
	expect(getMessageText(ends[0]!.result)).toContain("`then_run` runs a shell command");
	expect(existsSync(outside)).toBe(false);
	expect(existsSync(join(harness.tempDir, "marker"))).toBe(false);
});
