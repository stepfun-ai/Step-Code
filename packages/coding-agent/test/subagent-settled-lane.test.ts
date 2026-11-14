import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterAll, afterEach, expect, test } from "vitest";
import { createStepSubagentExtension, isFailed, type StepSubagentDetails } from "../src/features/step-subagent.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * A settled subagent run is not automatically a successful one, on the real path.
 *
 * A real `--mode rpc` child is spawned through the production rpc adapter and
 * parsed by the production projection. Its assistant message keeps the provider's
 * `stop` — that is what an empty kernel turn looks like — so the only evidence
 * that the lane failed is `agent_settled.failure`. This test fails if the adapter
 * goes back to treating settlement as success.
 */
const childPath = fileURLToPath(new URL("./fixtures/subagent-settled-child.mjs", import.meta.url));
const agentRoot = mkdtempSync(join(tmpdir(), "step-subagent-settled-"));
const harnesses: Harness[] = [];
const RETRY_RM = { recursive: true, force: true, maxRetries: 20, retryDelay: 50 } as const;
const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const CHILD_ENV_KEYS = ["SETTLED_MODE", "STEP_CODING_AGENT_DIR"];
const originalChildEnv = Object.fromEntries(CHILD_ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(async () => {
	process.argv = [...originalArgv];
	process.execArgv = [...originalExecArgv];
	for (const key of CHILD_ENV_KEYS) {
		const value = originalChildEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	// The real rpc child runs in the harness dir and is still exiting after its stdin closes.
	// Windows refuses to remove a live process's cwd, so retry asynchronously (a sync retry
	// would block the loop that delivers the child's EOF) before the harness cleans up.
	await Promise.all(harnesses.map((harness) => rm(harness.tempDir, RETRY_RM)));
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

afterAll(() => {
	rmSync(agentRoot, { recursive: true, force: true });
});

async function runAgainstRealChild(mode: "failure" | "success"): Promise<StepSubagentDetails> {
	process.env.SETTLED_MODE = mode;
	process.env.STEP_CODING_AGENT_DIR = agentRoot;
	// The default runner spawns `process.argv[1]`; point it at the fake rpc child
	// and keep the parent's TS loader out of a plain-ESM child process.
	process.argv[1] = childPath;
	process.execArgv = process.execArgv.filter((arg) => !/^(?:--import|--loader|--require|-r)$/u.test(arg));

	const harness = await createHarness({
		extensionFactories: [{ name: "step-subagent", factory: createStepSubagentExtension({ agentDir: agentRoot }) }],
	});
	harnesses.push(harness);

	let details: StepSubagentDetails | undefined;
	harness.session.subscribe((event) => {
		if (event.type !== "tool_execution_end") return;
		const result = event.result as { details?: StepSubagentDetails } | undefined;
		if (result?.details?.results) details = result.details;
	});

	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: "inspect" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("parent done"),
	]);
	await harness.session.prompt("delegate");
	if (!details) throw new Error("the subagent tool published no details");
	return details;
}

test("a settled child that reports a failure marks its lane failed", async () => {
	const details = await runAgainstRealChild("failure");
	const [record] = details.results;
	expect(record.status).toBe("failed");
	expect(record.exitCode).toBe(1);
	expect(record.stopReason).toBe("error");
	expect(record.errorMessage).toBe("The model returned no visible answer or executable tool call.");
	expect(isFailed(record)).toBe(true);
});

test("a settled child without a failure keeps its lane successful", async () => {
	// The transcript is empty and the assistant message says `stop`: without the
	// explicit outcome this is indistinguishable from the failing case.
	const details = await runAgainstRealChild("success");
	const [record] = details.results;
	expect(record.status).toBe("completed");
	expect(record.exitCode).toBe(0);
	expect(isFailed(record)).toBe(false);
});
