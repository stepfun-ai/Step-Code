import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BashExecutionResult, BashOperations } from "../../../src/core/tools/bash.ts";
import { createStepToolProfile } from "../../../src/step/tool-profile.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "../harness.ts";

describe("command execution results through the agent loop", () => {
	let directory: string;
	let harness: Harness | undefined;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "step-command-results-"));
	});

	afterEach(async () => {
		await harness?.session.abort();
		harness?.cleanup();
		harness = undefined;
		await rm(directory, { recursive: true, force: true });
	});

	async function setup(exec: BashOperations["exec"]) {
		harness = await createHarness({
			tools: [],
			initialActiveToolNames: ["run_command"],
			extensionFactories: [
				(pi) => {
					const command = createStepToolProfile(directory, {
						agentDir: join(directory, "agent"),
						bash: { operations: { exec } },
					}).find((tool) => tool.name === "run_command");
					if (!command) throw new Error("Command tool is missing");
					pi.registerTool(command);
				},
			],
		});
		await harness.session.bindExtensions({ mode: "print" });
		return harness;
	}

	it.each([0, 1, 7])("returns exit code %i without a tool error", async (exitCode) => {
		const exec = vi.fn<BashOperations["exec"]>(async (_command, _cwd, { onData }) => {
			onData(Buffer.from("command output\ndiagnostic output\n"));
			return { exitCode };
		});
		const run = await setup(exec);
		run.setResponses([
			fauxAssistantMessage(fauxToolCall("run_command", { command: "fixture" }, { id: "command" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				expect(result).toMatchObject({
					isError: false,
					details: { execution: { status: "exited", exitCode, timedOut: false, aborted: false } },
				});
				expect(getMessageText(result)).toContain("command output");
				expect(getMessageText(result)).toContain("diagnostic output");
				expect(getMessageText(result)).toContain(`Command exited with code ${exitCode}`);
				return fauxAssistantMessage("inspected the command result");
			},
		]);
		await run.session.prompt("Execute the fixture and inspect its result.");
		expect(getAssistantTexts(run)).toContain("inspected the command result");
		expect(exec).toHaveBeenCalledTimes(1);
		expect(run.eventsOfType("tool_execution_end")[0]).toMatchObject({ isError: false });
	});

	it("keeps malformed arguments and unknown tools as errors without executing", async () => {
		const exec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
		const run = await setup(exec);
		run.setResponses([
			fauxAssistantMessage([fauxToolCall("run_command", { cmd: "fixture" }), fauxToolCall("missing_command", {})], {
				stopReason: "toolUse",
			}),
			(context) => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				expect(results).toHaveLength(2);
				expect(results.every((result) => result.isError)).toBe(true);
				return fauxAssistantMessage("correct the invalid calls");
			},
		]);
		await run.session.prompt("Exercise invalid tool calls.");
		expect(getAssistantTexts(run)).toContain("correct the invalid calls");
		expect(exec).not.toHaveBeenCalled();
	});

	it.each([
		{ exitCode: null, timedOut: true, signal: "SIGTERM", status: "timed_out" },
		{ exitCode: 0, timedOut: true, signal: null, status: "timed_out" },
		{ exitCode: null, timedOut: false, signal: "SIGTERM", status: "signaled" },
		{ exitCode: null, timedOut: false, signal: null, status: "unknown" },
	])("preserves $status as an execution outcome, not a tool error", async ({ status, ...facts }) => {
		const exec = vi.fn<BashOperations["exec"]>(async () => facts satisfies BashExecutionResult);
		const run = await setup(exec);
		run.setResponses([
			fauxAssistantMessage(fauxToolCall("run_command", { command: "fixture" }), { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				expect(result).toMatchObject({
					isError: false,
					details: { execution: { ...facts, status, aborted: false } },
				});
				if (facts.timedOut) expect(getMessageText(result)).toContain("Command timed out");
				if (status === "unknown") expect(getMessageText(result)).toContain("check its effects");
				return fauxAssistantMessage("inspected execution facts");
			},
		]);
		await run.session.prompt("Inspect the observed execution outcome.");
		expect(getAssistantTexts(run)).toContain("inspected execution facts");
		expect(exec).toHaveBeenCalledTimes(1);
	});

	it("keeps executor faults as tool errors and retains prior output", async () => {
		const exec = vi.fn<BashOperations["exec"]>(async (_command, _cwd, { onData }) => {
			onData(Buffer.from("output before the executor fault\n"));
			throw new Error("executor connection lost");
		});
		const run = await setup(exec);
		run.setResponses([
			fauxAssistantMessage(fauxToolCall("run_command", { command: "fixture" }), { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				expect(result).toMatchObject({ isError: true });
				expect(getMessageText(result)).toContain("executor connection lost");
				expect(getMessageText(result)).toContain("output before the executor fault");
				return fauxAssistantMessage("check state before retrying");
			},
		]);
		await run.session.prompt("Exercise an executor fault.");
		expect(getAssistantTexts(run)).toContain("check state before retrying");
		expect(exec).toHaveBeenCalledTimes(1);
	});
});
