import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ToolRenderContext } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";
import { createStepToolProfile } from "../src/step/tool-profile.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { killProcessTree } from "../src/utils/shell.ts";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe("Step foreground run_command timeout", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "step-command-timeout-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	function commandTool() {
		const exec = vi.fn<BashOperations["exec"]>(async (_command, _cwd, { onData }) => {
			onData(Buffer.from("command completed\n"));
			return { exitCode: 0 };
		});
		const tool = createStepToolProfile(directory, {
			agentDir: join(directory, "agent"),
			bash: { operations: { exec } },
		}).find((candidate) => candidate.name === "run_command");
		if (!tool) throw new Error("Step run_command tool is missing");
		return { tool, exec };
	}

	it("defaults an omitted foreground timeout to 120 seconds, including a cwd override", async () => {
		// Regression: without the Step fallback a foreground command can consume
		// the whole outer run budget without returning a recoverable tool error.
		// Inspect the native operation arguments; never wait for the 120s timer.
		const { tool, exec } = commandTool();
		await mkdir(join(directory, "nested"));
		await tool.execute("default", { command: "fixture" }, undefined, undefined, undefined as never);
		await tool.execute(
			"default-with-cwd",
			{ command: "fixture", cwd: "nested" },
			undefined,
			undefined,
			undefined as never,
		);

		expect(exec.mock.calls.map((call) => call[2].timeout)).toEqual([120, 120]);
		expect(exec.mock.calls.map((call) => call[1])).toEqual([directory, join(directory, "nested")]);
	});

	it.each([1_000, 1_250, 600_000])("preserves explicit timeout_ms=%i in native seconds", async (timeoutMs) => {
		const { tool, exec } = commandTool();
		await tool.execute(
			"explicit",
			{ command: "fixture", timeout_ms: timeoutMs },
			undefined,
			undefined,
			undefined as never,
		);

		expect(exec).toHaveBeenCalledTimes(1);
		expect(exec.mock.calls[0]?.[2].timeout).toBe(timeoutMs / 1000);
	});

	it("uses an existing numeric host context timeout before the Step default", async () => {
		const { tool, exec } = commandTool();
		const context = { cwd: directory, commandTimeoutMs: 180_500 } as unknown as ExtensionContext;
		await tool.execute("context", { command: "fixture" }, undefined, undefined, context);

		expect(exec.mock.calls[0]?.[2].timeout).toBe(180.5);
	});

	it("lets an explicit timeout override the host context", async () => {
		const { tool, exec } = commandTool();
		const context = { cwd: directory, commandTimeoutMs: 2_000 } as unknown as ExtensionContext;
		await tool.execute(
			"explicit-over-context",
			{ command: "fixture", timeout_ms: 240_000 },
			undefined,
			undefined,
			context,
		);

		expect(exec.mock.calls[0]?.[2].timeout).toBe(240);
	});

	it("resolves a relative cwd against the host context without losing its timeout", async () => {
		const { tool, exec } = commandTool();
		const hostCwd = join(directory, "host");
		await mkdir(join(hostCwd, "nested"), { recursive: true });
		const context = { cwd: hostCwd, commandTimeoutMs: 45_000 } as unknown as ExtensionContext;
		await tool.execute("cwd-context", { command: "fixture", cwd: "nested" }, undefined, undefined, context);

		expect(exec.mock.calls[0]?.[1]).toBe(join(hostCwd, "nested"));
		expect(exec.mock.calls[0]?.[2].timeout).toBe(45);
	});

	it("keeps an absolute cwd and explicit timeout independent of host defaults", async () => {
		const { tool, exec } = commandTool();
		const absoluteCwd = join(directory, "absolute");
		await mkdir(absoluteCwd);
		const context = { cwd: join(directory, "host"), commandTimeoutMs: 5_000 } as unknown as ExtensionContext;
		await tool.execute(
			"cwd-explicit",
			{ command: "fixture", cwd: absoluteCwd, timeout_ms: 90_000 },
			undefined,
			undefined,
			context,
		);

		expect(exec.mock.calls[0]?.[1]).toBe(absoluteCwd);
		expect(exec.mock.calls[0]?.[2].timeout).toBe(90);
	});

	it.each([0, -1, 999, 600_001, 1_000.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid explicit timeout_ms=%s before executing, even with a valid host default",
		async (timeoutMs) => {
			const { tool, exec } = commandTool();
			const context = { cwd: directory, commandTimeoutMs: 120_000 } as unknown as ExtensionContext;
			await expect(
				tool.execute(
					"invalid",
					{ command: "must not execute", timeout_ms: timeoutMs },
					undefined,
					undefined,
					context,
				),
			).rejects.toThrow("timeout_ms must be between 1000 and 600000");
			expect(exec).not.toHaveBeenCalled();
		},
	);

	it("retains native Bash's omitted timeout and fractional seconds contract", async () => {
		const exec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
		const bash = createBashTool(directory, { operations: { exec }, agentDir: join(directory, "agent") });
		await bash.execute("native-omitted", { command: "fixture" });
		await bash.execute("native-explicit", { command: "fixture", timeout: 0.125 });

		expect(exec.mock.calls.map((call) => call[2].timeout)).toEqual([undefined, 0.125]);
	});

	it("does not render a foreground deadline for an omitted-timeout background call or result", () => {
		const { tool } = commandTool();
		initTheme("dark", false);
		const args = { command: "fixture-command", run_in_background: true };
		const context: ToolRenderContext<Record<string, unknown>, typeof args> = {
			args,
			toolCallId: "render-background",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: directory,
			executionStarted: false,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
		};
		const call = tool.renderCall!(args, theme, context).render(200).join("\n");
		const result = tool.renderResult!(
			{ content: [{ type: "text", text: "Started background command." }], details: { background: true } },
			{ expanded: false, isPartial: false },
			theme,
			context,
		)
			.render(200)
			.join("\n");
		expect(call).toContain("fixture-command");
		expect(call).not.toContain("timeout");
		expect(result).toContain("Started background command.");
		expect(result).not.toContain("timeout");

		// A positive control verifies that this renderer exposes foreground timeouts.
		const foreground = { command: "fixture-command", timeout_ms: 5_000 };
		expect(
			tool.renderCall!(foreground, theme, { ...context, args: foreground })
				.render(200)
				.join("\n"),
		).toContain("timeout 5s");
	});

	it.skipIf(process.platform === "win32")(
		"keeps background commands on their detached lifecycle and ignores foreground timeout_ms",
		async () => {
			const { tool, exec } = commandTool();
			// The owned process stays alive beyond the explicit 1s foreground limit.
			// A self-exit bounds cleanup even if the test runner is interrupted.
			const program = [
				'setTimeout(() => process.stdout.write("background-after-timeout\\n"), 1500);',
				"setTimeout(() => process.exit(0), 8000);",
			].join(" ");
			const result = await tool.execute(
				"background",
				{
					command: `exec ${shellQuote(process.execPath)} -e ${shellQuote(program)}`,
					run_in_background: true,
					timeout_ms: 1_000,
				},
				undefined,
				undefined,
				{ cwd: directory, commandTimeoutMs: 1_000 } as unknown as ExtensionContext,
			);
			const details = result.details as { background: boolean; pid: number; logPath: string };
			try {
				expect(details.background).toBe(true);
				expect(Number.isSafeInteger(details.pid) && details.pid > 0).toBe(true);
				expect(exec).not.toHaveBeenCalled();
				expect(() => process.kill(details.pid, 0)).not.toThrow();
				await expect
					.poll(async () => readFile(details.logPath, "utf8"), { timeout: 5_000 })
					.toContain("background-after-timeout");
			} finally {
				// Only this test's returned process group is targeted, never a global sweep.
				if (Number.isSafeInteger(details.pid) && details.pid > 0) killProcessTree(details.pid);
				await rm(details.logPath, { force: true });
			}
		},
	);
});
