import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import { createStepExtension } from "../../../src/features/step.ts";
import { createStepToolProfile } from "../../../src/step/tool-profile.ts";
import { killProcessTree } from "../../../src/utils/shell.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "../harness.ts";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function killRecordedChild(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function isRunning(pid: number): Promise<boolean> {
	try {
		if (process.platform === "linux") {
			// A killed descendant may briefly remain a zombie under the host's PID 1.
			// That is no longer executing; only examine PIDs recorded by our fixture.
			const status = await readFile(`/proc/${pid}/stat`, "utf8");
			return !["Z", "X"].includes(status.slice(status.lastIndexOf(")") + 2).split(" ")[0]);
		}
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

describe("Step run_command timeout recovery through the agent loop", () => {
	let directory: string;
	let harness: Harness | undefined;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "step-timeout-recovery-"));
	});

	afterEach(async () => {
		await harness?.session.abort();
		harness?.cleanup();
		harness = undefined;
		await rm(directory, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")(
		"returns a 1s foreground timeout as a failed tool result and completes the next command",
		async () => {
			harness = await createHarness({
				tools: [],
				initialActiveToolNames: ["run_command"],
				extensionFactories: [
					(pi) => {
						const tool = createStepToolProfile(directory, { agentDir: join(directory, "agent") }).find(
							(candidate) => candidate.name === "run_command",
						);
						if (!tool) throw new Error("Step run_command tool is missing");
						pi.registerTool(tool);
					},
				],
			});
			await harness.session.bindExtensions({ mode: "print" });
			const program = [
				'const { spawn } = require("node:child_process");',
				'const { writeFileSync } = require("node:fs");',
				'const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 8000)"], { stdio: "ignore" });',
				'child.once("spawn", () => {',
				'writeFileSync("owned-pids.json", JSON.stringify({ parent: process.pid, child: child.pid }));',
				'process.stdout.write("owned-child-ready\\n");',
				"});",
				'setTimeout(() => { child.kill("SIGKILL"); process.exit(0); }, 8000);',
			].join(" ");
			const command = `exec ${shellQuote(process.execPath)} -e ${shellQuote(program)}`;
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("run_command", { command, cwd: directory, timeout_ms: 1_000 }, { id: "owned-timeout" }),
					{ stopReason: "toolUse" },
				),
				(context) => {
					const failed = context.messages.find(
						(message) => message.role === "toolResult" && message.toolCallId === "owned-timeout",
					);
					expect(failed).toMatchObject({ toolName: "run_command", isError: true });
					expect(getMessageText(failed)).toContain("owned-child-ready");
					expect(getMessageText(failed)).toContain("Command timed out after 1 seconds");
					return fauxAssistantMessage(
						fauxToolCall(
							"run_command",
							{ command: "printf 'next-command-ok\\n'", cwd: directory },
							{ id: "after-timeout" },
						),
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					const succeeded = context.messages.find(
						(message) => message.role === "toolResult" && message.toolCallId === "after-timeout",
					);
					expect(succeeded).toMatchObject({ isError: false });
					expect(getMessageText(succeeded)).toContain("next-command-ok");
					return fauxAssistantMessage("continued after the timed-out command");
				},
			]);

			// A separate safety bound cannot masquerade as the native 1s timeout.
			let watchdogFired = false;
			const watchdog = setTimeout(() => {
				watchdogFired = true;
				void harness?.session.abort();
			}, 6_000);
			let owned: { parent: number; child: number } | undefined;
			try {
				await harness.session.prompt("Run the local command and recover from a timeout if necessary.");
				expect(watchdogFired).toBe(false);
				expect(harness.faux.state.callCount).toBe(3);
				expect(harness.getPendingResponseCount()).toBe(0);
				expect(getAssistantTexts(harness)).toContain("continued after the timed-out command");
				const ends = harness.eventsOfType("tool_execution_end");
				expect(ends.map((event) => [event.toolCallId, event.isError])).toEqual([
					["owned-timeout", true],
					["after-timeout", false],
				]);
				expect(ends[0]?.result.terminate).not.toBe(true);
				owned = JSON.parse(await readFile(join(directory, "owned-pids.json"), "utf8")) as {
					parent: number;
					child: number;
				};
				for (const pid of [owned.parent, owned.child]) {
					expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
					await expect.poll(() => isRunning(pid), { timeout: 3_000 }).toBe(false);
				}
			} finally {
				clearTimeout(watchdog);
				await harness.session.abort();
				// Recover our own PID receipt even if an assertion failed before it was read.
				if (!owned) {
					const receipt = await readFile(join(directory, "owned-pids.json"), "utf8").catch(() => "");
					if (receipt) owned = JSON.parse(receipt) as { parent: number; child: number };
				}
				if (owned && Number.isSafeInteger(owned.parent) && owned.parent > 0 && (await isRunning(owned.parent))) {
					killProcessTree(owned.parent);
				}
				if (owned && Number.isSafeInteger(owned.child) && owned.child > 0 && (await isRunning(owned.child))) {
					// This descendant shares the parent's group, so target its own PID only.
					killRecordedChild(owned.child);
				}
			}
		},
	);

	it("retains a terminating explicit tool deny for bounded commands", async () => {
		const exec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
		harness = await createHarness({
			tools: [],
			initialActiveToolNames: ["run_command"],
			extensionFactories: [
				createStepExtension({
					permission: {
						env: {},
						initialPreset: "bypass",
						toolOverrides: { run_command: "deny" },
					},
				}),
				(pi) => {
					const tool = createStepToolProfile(directory, {
						agentDir: join(directory, "agent"),
						bash: { operations: { exec } },
					}).find((candidate) => candidate.name === "run_command");
					if (!tool) throw new Error("Step run_command tool is missing");
					pi.registerTool(tool);
				},
			],
		});
		await harness.session.bindExtensions({ mode: "print" });
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_command", { command: "printf 'must-not-run\\n'" }, { id: "explicit-deny" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("must not continue after an explicit deny"),
		]);
		await harness.session.prompt("Exercise the existing explicit tool deny.");

		expect(exec).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("tool_execution_end")).toEqual([
			expect.objectContaining({
				toolCallId: "explicit-deny",
				isError: true,
				result: expect.objectContaining({ terminate: true }),
			}),
		]);
	});
});
