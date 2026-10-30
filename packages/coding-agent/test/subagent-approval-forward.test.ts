import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { StepSubagentRunInput } from "../src/features/step-subagent.ts";
import type { StepAgentConfig } from "../src/features/step-subagent-agents.ts";
import { liveSubagentSessions } from "../src/features/subagent/lane-lifecycle.ts";
import { createSubagentRpcSession } from "../src/features/subagent/rpc-adapter.ts";

/**
 * A subagent child runs `--mode rpc`, where only a UI request can ask a human
 * anything. Under Ask (or a hazardous command under Approve for Me) the child's
 * Step permission controller calls `ui.confirm`, and the adapter used to cancel
 * every blocking dialog: the write was denied without anyone being asked and the
 * parent model retried it in the main session. These tests pin the forwarded
 * verdict for a host that can show the card, and the old cancel for one that
 * cannot.
 */

const agent: StepAgentConfig = {
	name: "general",
	description: "test agent",
	systemPrompt: "you are a test agent",
	source: "builtin",
};

const workspaces: string[] = [];

afterEach(async () => {
	liveSubagentSessions.clear();
	await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "step-subagent-approval-"));
	workspaces.push(dir);
	return dir;
}

function runInput(overrides: Partial<StepSubagentRunInput> = {}): StepSubagentRunInput {
	return { agent, task: "write the file", cwd: process.cwd(), ...overrides };
}

/**
 * Stand in for `step --mode rpc`: ack the prompt, raise a confirmation, and
 * record the answer the parent sent back. `currentStepInvocation` reuses
 * `process.argv[1]` when it is an existing script, so pointing it here makes
 * `createSubagentRpcSession` spawn this instead of a real agent.
 */
async function fakeChild(answerPath: string): Promise<string> {
	const dir = await workspace();
	const file = path.join(dir, "fake-child.mjs");
	await writeFile(
		file,
		`import { writeFileSync } from "node:fs";
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString();
	const lines = buffer.split("\\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		const command = JSON.parse(line);
		if (command.type === "prompt") {
			process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true }) + "\\n");
			process.stdout.write(JSON.stringify({
				type: "extension_ui_request",
				id: "confirm-1",
				method: "confirm",
				title: "Approve write_file [1a2b3c4d]",
				message: "Call: call-1\\nwrite_file can modify the workspace or execute a command\\n\\nwrite_file path=src/sub.txt content=hello\\n\\nBatch calls may ask separately\\nbefore approved tools begin running.",
			}) + "\\n");
			continue;
		}
		if (command.type === "extension_ui_response" && command.id === "confirm-1") {
			writeFileSync(${JSON.stringify(answerPath)}, JSON.stringify(command));
			process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
		}
	}
});
setInterval(() => {}, 1 << 30);
`,
		"utf8",
	);
	return file;
}

async function runChildTurn(
	input: Partial<StepSubagentRunInput>,
): Promise<{ answer: Record<string, unknown> | undefined; prompts: Array<{ title: string; message: string }> }> {
	const answerPath = path.join(await workspace(), "answer.json");
	const script = await fakeChild(answerPath);
	const originalArgv1 = process.argv[1];
	process.argv[1] = script;
	try {
		const childInput = runInput({ turnIdleTimeoutMs: 5_000, ...input });
		const session = await createSubagentRpcSession(
			childInput,
			`approval-forward-${Math.random().toString(16).slice(2)}`,
		);
		const result = await session.runTurn(childInput);
		expect(result.stopReason).toBeUndefined();
		session.stop();
		const answer = JSON.parse(await readFile(answerPath, "utf8").catch(() => "null"));
		return { answer: answer ?? undefined, prompts: promptsSeen };
	} finally {
		process.argv[1] = originalArgv1;
	}
}

// `promptsSeen` is filled by the handler each test registers.
let promptsSeen: Array<{ title: string; message: string }> = [];

test("a host that can ask forwards the child's confirmation and returns the user's verdict", async () => {
	promptsSeen = [];
	const { answer, prompts } = await runChildTurn({
		requestApproval: async (prompt) => {
			promptsSeen.push({ title: prompt.title, message: prompt.message });
			return true;
		},
	});
	expect(prompts).toHaveLength(1);
	expect(prompts[0]?.title).toBe("Approve write_file [1a2b3c4d]");
	// The child's own dialog body carries the summarized input: the host has no
	// structured arguments for a call made in another process.
	expect(prompts[0]?.message).toContain("write_file path=src/sub.txt content=hello");
	expect(answer).toMatchObject({ type: "extension_ui_response", id: "confirm-1", confirmed: true });
});

test("a denied verdict reaches the child as confirmed:false", async () => {
	promptsSeen = [];
	const { answer } = await runChildTurn({
		requestApproval: async () => false,
	});
	expect(answer).toMatchObject({ id: "confirm-1", confirmed: false });
});

test("without a handler the child's blocking dialog is still cancelled, never left waiting", async () => {
	promptsSeen = [];
	const { answer } = await runChildTurn({});
	expect(answer).toMatchObject({ id: "confirm-1", cancelled: true });
});

test("a handler that fails denies rather than leaving the child's turn hanging", async () => {
	promptsSeen = [];
	const { answer } = await runChildTurn({
		requestApproval: async () => {
			throw new Error("the host lost its approval channel");
		},
	});
	expect(answer).toMatchObject({ id: "confirm-1", confirmed: false });
});
