import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@step-harness/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import { createStepToolProfile } from "../../../src/step/tool-profile.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "../harness.ts";

const fixturePath = fileURLToPath(new URL("../../fixtures/command-runtime-recovery.mjs", import.meta.url));

type ProcessIdentity = { pid: number; startTime: string };
type OwnedProcesses = { parent: ProcessIdentity; child: ProcessIdentity };

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function ownedProcessRunning(identity: ProcessIdentity): Promise<boolean> {
	try {
		const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[19] === identity.startTime && !["Z", "X"].includes(fields[0]);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function stopOwnedProcesses(directory: string): Promise<void> {
	let owned: OwnedProcesses;
	try {
		owned = JSON.parse(await readFile(join(directory, "owned-pids.json"), "utf8")) as OwnedProcesses;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const identity of [owned.child, owned.parent]) {
		if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !(await ownedProcessRunning(identity))) continue;
		try {
			process.kill(identity.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}

describe("Step command runtime recovery", () => {
	let directory: string;
	let harness: Harness | undefined;
	const outputPaths = new Set<string>();

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "step-runtime-recovery-"));
	});

	afterEach(async () => {
		if (process.platform === "linux") await stopOwnedProcesses(directory);
		await harness?.session.abort();
		harness?.cleanup();
		harness = undefined;
		for (const outputPath of outputPaths) await rm(outputPath, { force: true });
		outputPaths.clear();
		await rm(directory, { recursive: true, force: true });
	});

	async function setup(operations?: BashOperations): Promise<Harness> {
		harness = await createHarness({
			models: [{ id: "runtime-recovery-faux", contextWindow: 1_000_000, maxTokens: 64_000 }],
			tools: [],
			initialActiveToolNames: ["run_command", "read_file"],
			extensionFactories: [
				(pi) => {
					const profile = createStepToolProfile(directory, {
						agentDir: join(directory, "agent"),
						...(operations ? { bash: { operations } } : {}),
					});
					for (const tool of profile) {
						if (tool.name === "run_command" || tool.name === "read_file") pi.registerTool(tool);
					}
				},
			],
		});
		await harness.session.bindExtensions({ mode: "print" });
		return harness;
	}

	describe.skipIf(process.platform !== "linux")("separate-group descendants", () => {
		it.each(["idle", "stream"])("stops a %s descendant and returns a timeout to the next faux turn", async (mode) => {
			const current = await setup();
			const command = `exec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} parent ${shellQuote(directory)} ${mode}`;
			let observed: ToolResultMessage | undefined;
			current.setResponses([
				fauxAssistantMessage(
					fauxToolCall("run_command", { command, cwd: directory, timeout_ms: 1_000 }, { id: "timed-command" }),
					{ stopReason: "toolUse" },
				),
				(context) => {
					observed = context.messages.find(
						(message) => message.role === "toolResult" && message.toolCallId === "timed-command",
					) as ToolResultMessage | undefined;
					return fauxAssistantMessage("The timeout was returned.");
				},
			]);
			let watchdogFired = false;
			const watchdog = setTimeout(() => {
				watchdogFired = true;
				void current.session.abort();
			}, 4_000);
			const startedAt = performance.now();
			try {
				await current.session.prompt("Run the bounded local fixture.");
				expect(watchdogFired).toBe(false);
				expect(performance.now() - startedAt).toBeLessThan(3_000);
				expect(current.faux.state.callCount).toBe(2);
				expect(observed).toMatchObject({ isError: true, toolName: "run_command" });
				expect(getMessageText(observed)).toContain("owned-child-ready");
				expect(getMessageText(observed)).toContain("Command timed out after 1 seconds");
				expect(getMessageText(observed)).not.toContain("terminated by signal");
				const owned = JSON.parse(await readFile(join(directory, "owned-pids.json"), "utf8")) as OwnedProcesses;
				for (const identity of [owned.parent, owned.child]) {
					await expect.poll(() => ownedProcessRunning(identity), { timeout: 1_000 }).toBe(false);
				}
				expect(current.eventsOfType("tool_execution_end")[0]?.result.terminate).not.toBe(true);
			} finally {
				clearTimeout(watchdog);
				await stopOwnedProcesses(directory);
			}
		});
	});

	it.skipIf(process.platform !== "linux")(
		"keeps caller abort ahead of the kill signal and retains its error for a resumed faux turn",
		async () => {
			const current = await setup();
			const command = `exec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} parent ${shellQuote(directory)} stream`;
			current.setResponses([
				fauxAssistantMessage(
					fauxToolCall("run_command", { command, cwd: directory, timeout_ms: 5_000 }, { id: "aborted-command" }),
					{ stopReason: "toolUse" },
				),
			]);
			const pending = current.session.prompt("Start the local command.");
			try {
				await expect
					.poll(
						() =>
							current
								.eventsOfType("tool_execution_update")
								.some((event) => getMessageText(event.partialResult).includes("owned-child-ready")),
						{ timeout: 2_000 },
					)
					.toBe(true);
				await current.session.abort();
				await pending;
				let observed: ToolResultMessage | undefined;
				current.setResponses([
					(context) => {
						observed = context.messages.find(
							(message) => message.role === "toolResult" && message.toolCallId === "aborted-command",
						) as ToolResultMessage | undefined;
						return fauxAssistantMessage("Resumed after caller cancellation.");
					},
				]);
				await current.session.prompt("Inspect the previous command result.");
				expect(observed).toMatchObject({ isError: true });
				expect(getMessageText(observed)).toContain("owned-child-ready");
				expect(getMessageText(observed)).toContain("Command aborted");
				expect(getMessageText(observed)).not.toMatch(/timed out|terminated by signal/u);
				const owned = JSON.parse(await readFile(join(directory, "owned-pids.json"), "utf8")) as OwnedProcesses;
				for (const identity of [owned.parent, owned.child]) {
					await expect.poll(() => ownedProcessRunning(identity), { timeout: 1_000 }).toBe(false);
				}
			} finally {
				await stopOwnedProcesses(directory);
				await current.session.abort();
				await pending;
			}
		},
	);

	describe.skipIf(process.platform === "win32")("signal termination", () => {
		it.each(["SIGTERM", "SIGKILL"])(
			"reports %s and captured output as an error in the next faux request",
			async (signal) => {
				const current = await setup();
				const command = `exec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} signal ${shellQuote(directory)} ${signal}`;
				let observed: ToolResultMessage | undefined;
				current.setResponses([
					fauxAssistantMessage(
						fauxToolCall("run_command", { command, timeout_ms: 1_000 }, { id: "signal-command" }),
						{ stopReason: "toolUse" },
					),
					(context) => {
						observed = context.messages.find(
							(message) => message.role === "toolResult" && message.toolCallId === "signal-command",
						) as ToolResultMessage | undefined;
						return fauxAssistantMessage("The interrupted test needs attention.");
					},
				]);
				await current.session.prompt("Run the local signal fixture.");
				expect(current.faux.state.callCount).toBe(2);
				expect(observed).toMatchObject({ isError: true });
				expect(getMessageText(observed)).toContain("test-runner-started");
				expect(getMessageText(observed)).toContain(`Command terminated by signal ${signal}`);
				expect(current.eventsOfType("tool_execution_end")[0]?.result.terminate).not.toBe(true);
			},
		);
	});

	it.each(["success", "exit", "timeout", "abort"] as const)(
		"preserves the sole diagnostic copy below 50KiB on %s before applying the Step cap",
		async (outcome) => {
			const marker = "SOLE_COPY_DIAGNOSTIC_caf\u00e9";
			const bytes = Buffer.from(
				`${"head".repeat(3_000)}\n${marker}\n${"tail".repeat(3_000)}\nEOF_DIAGNOSTIC\n`,
				"utf8",
			);
			expect(bytes.length).toBeLessThan(50 * 1024);
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					const split = bytes.indexOf(Buffer.from("\u00e9")) + 1;
					onData(bytes.subarray(0, split));
					onData(bytes.subarray(split));
					if (outcome === "timeout") throw new Error("timeout:1");
					if (outcome === "abort") throw new Error("aborted");
					return { exitCode: outcome === "exit" ? 7 : 0 };
				},
			};
			const current = await setup(operations);
			let observed: ToolResultMessage | undefined;
			let recovered: ToolResultMessage | undefined;
			let fullOutputPath: string | undefined;
			current.setResponses([
				fauxAssistantMessage(
					fauxToolCall("run_command", { command: "fake-test", max_output_chars: 1_000 }, { id: "capped-command" }),
					{ stopReason: "toolUse" },
				),
				(context) => {
					observed = context.messages.find(
						(message) => message.role === "toolResult" && message.toolCallId === "capped-command",
					) as ToolResultMessage | undefined;
					fullOutputPath = /Full output: ([^\]\n]+)/u.exec(getMessageText(observed))?.[1];
					if (!fullOutputPath) return fauxAssistantMessage("Missing recoverable log.");
					outputPaths.add(fullOutputPath);
					return fauxAssistantMessage(
						fauxToolCall(
							"read_file",
							{ path: fullOutputPath, start_line: 2, end_line: 2 },
							{ id: "read-diagnostic" },
						),
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					recovered = context.messages.find(
						(message) => message.role === "toolResult" && message.toolCallId === "read-diagnostic",
					) as ToolResultMessage | undefined;
					return fauxAssistantMessage("Recovered the diagnostic from the saved log.");
				},
			]);
			await current.session.prompt("Run the test and inspect the complete log when truncated.");
			expect(fullOutputPath).toBeDefined();
			expect(observed?.isError).toBe(outcome !== "success");
			expect(getMessageText(observed).length).toBeLessThanOrEqual(1_000);
			expect(getMessageText(observed)).not.toContain(marker);
			expect(getMessageText(observed)).toContain("EOF_DIAGNOSTIC");
			if (outcome === "exit") expect(getMessageText(observed)).toContain("Command exited with code 7");
			if (outcome === "timeout") expect(getMessageText(observed)).toContain("Command timed out after 1 seconds");
			if (outcome === "abort") expect(getMessageText(observed)).toContain("Command aborted");
			expect(await readFile(fullOutputPath!)).toEqual(bytes);
			expect(getMessageText(recovered)).toContain(marker);
			expect(recovered?.isError).toBe(false);
			expect(current.faux.state.callCount).toBe(3);
			expect(getAssistantTexts(current)).toContain("Recovered the diagnostic from the saved log.");
		},
	);
});
