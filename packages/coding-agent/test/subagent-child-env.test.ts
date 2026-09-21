import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CHILD_MARKER, type StepSubagentRunInput } from "../src/features/step-subagent.ts";
import type { StepAgentConfig } from "../src/features/step-subagent-agents.ts";
import { liveSubagentSessions } from "../src/features/subagent/lane-lifecycle.ts";
import {
	buildSubagentChildEnv,
	createSubagentRpcSession,
	resolveSubagentTurnIdleTimeoutMs,
} from "../src/features/subagent/rpc-adapter.ts";
import { WORKFLOW_ACL_ENV } from "../src/features/workflow/acl-extension.ts";

const agent: StepAgentConfig = {
	name: "general",
	description: "test agent",
	systemPrompt: "you are a test agent",
	source: "builtin",
};

const workspaces: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	liveSubagentSessions.clear();
	await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "step-subagent-env-"));
	workspaces.push(dir);
	return dir;
}

function runInput(overrides: Partial<StepSubagentRunInput> = {}): StepSubagentRunInput {
	return { agent, task: "do the thing", cwd: process.cwd(), ...overrides };
}

// Regression: `subagent -> workflow` used to be ungated because
// STEP_DISABLE_WORKFLOW was keyed off `workflowAcl`, a permission payload rather
// than a depth marker. Subagent children carry no ACL, so they were misread as
// top-level and each fanned out another wave of workflow agents.
test("every rpc child is barred from fanning out again, with or without a workflow ACL", () => {
	vi.stubEnv("STEP_DISABLE_WORKFLOW", "");

	const plain = buildSubagentChildEnv(runInput());
	expect(plain[CHILD_MARKER]).toBe("1");
	expect(plain.STEP_DISABLE_WORKFLOW).toBe("1");

	const nested = buildSubagentChildEnv(runInput({ workflowAcl: { baseCwd: "/repo" } }));
	expect(nested[CHILD_MARKER]).toBe("1");
	expect(nested.STEP_DISABLE_WORKFLOW).toBe("1");
});

test("a workflow ACL is forwarded, and a stale inherited one is cleared", () => {
	vi.stubEnv(WORKFLOW_ACL_ENV, JSON.stringify({ baseCwd: "/inherited" }));

	const nested = buildSubagentChildEnv(runInput({ workflowAcl: { baseCwd: "/repo", readOnly: ["/repo/src"] } }));
	expect(JSON.parse(String(nested[WORKFLOW_ACL_ENV]))).toEqual({
		baseCwd: "/repo",
		readOnly: ["/repo/src"],
	});

	// Node's spawn drops undefined env values, so this clears the parent's ACL
	// instead of leaking it to a child that was not spawned by a workflow.
	expect(buildSubagentChildEnv(runInput())[WORKFLOW_ACL_ENV]).toBeUndefined();
});

test("turn idle timeout honors the env override and rejects junk", () => {
	expect(resolveSubagentTurnIdleTimeoutMs("1500")).toBe(1500);
	expect(resolveSubagentTurnIdleTimeoutMs("0")).toBe(0);
	expect(resolveSubagentTurnIdleTimeoutMs(undefined)).toBe(30 * 60_000);
	expect(resolveSubagentTurnIdleTimeoutMs("")).toBe(30 * 60_000);
	expect(resolveSubagentTurnIdleTimeoutMs("-5")).toBe(30 * 60_000);
	expect(resolveSubagentTurnIdleTimeoutMs("nonsense")).toBe(30 * 60_000);
});

/**
 * Stand in for the real `step --mode rpc` child. `currentStepInvocation` reuses
 * process.argv[1] when it is an existing js/ts file, so pointing argv[1] at this
 * script makes createSubagentRpcSession spawn it instead of a real agent.
 */
async function fakeChild(body: string): Promise<string> {
	const dir = await workspace();
	const file = path.join(dir, "fake-child.mjs");
	await writeFile(
		file,
		`let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString();
	const lines = buffer.split("\\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		const command = JSON.parse(line);
		if (command.type !== "prompt") continue;
		process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true }) + "\\n");
		${body}
	}
});
setInterval(() => {}, 1 << 30);
`,
		"utf8",
	);
	return file;
}

test("a child that acks the prompt then goes silent settles instead of stranding the parent", async () => {
	const script = await fakeChild("/* then never speak again */");
	const originalArgv1 = process.argv[1];
	process.argv[1] = script;
	try {
		const session = await createSubagentRpcSession(runInput({ turnIdleTimeoutMs: 400 }), "idle-turn-test");
		const result = await session.runTurn(runInput({ turnIdleTimeoutMs: 400 }));
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/produced no output/);
		session.stop();
	} finally {
		process.argv[1] = originalArgv1;
	}
}, 20_000);

test("streaming output keeps resetting the idle budget", async () => {
	// Emits well past the 400ms budget, then settles: the turn must survive.
	const script = await fakeChild(`
		let ticks = 0;
		const timer = setInterval(() => {
			ticks += 1;
			if (ticks <= 6) {
				process.stdout.write(JSON.stringify({ type: "progress-report", message: "working" }) + "\\n");
				return;
			}
			clearInterval(timer);
			process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
		}, 150);`);
	const originalArgv1 = process.argv[1];
	process.argv[1] = script;
	try {
		const session = await createSubagentRpcSession(runInput({ turnIdleTimeoutMs: 400 }), "streaming-turn-test");
		const result = await session.runTurn(runInput({ turnIdleTimeoutMs: 400 }));
		expect(result.stopReason).toBeUndefined();
		expect(result.exitCode).toBe(0);
		session.stop();
	} finally {
		process.argv[1] = originalArgv1;
	}
}, 20_000);
