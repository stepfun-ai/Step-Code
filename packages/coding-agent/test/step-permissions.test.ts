import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	AUTO_RESUME_PROMPT,
	containsDangerousLifecycleCommand,
	decideStepToolCall,
	isDangerousCommand,
	resolveInitialStepPermissionPreset,
	resolveInitialStepPermissionState,
	STEP_PERMISSION_PRESETS,
	StepAutoResumeController,
	StepPermissionController,
	stepPermissionStateForPreset,
} from "../src/step/permissions.ts";

describe("Step permission presets", () => {
	it("exposes the four stable presets in cycle order", () => {
		expect(STEP_PERMISSION_PRESETS.map((preset) => preset.id)).toEqual(["ask", "read-only", "bypass", "autopilot"]);
		const controller = new StepPermissionController({ env: {} });
		expect(controller.getState().preset).toBe("bypass");
		expect(controller.cycle().preset).toBe("autopilot");
		expect(controller.cycle().preset).toBe("ask");
		expect(controller.cycle().preset).toBe("read-only");
		expect(controller.cycle().preset).toBe("bypass");
		expect(
			new StepPermissionController({
				env: { STEP_PERMISSION_PRESET: "confirm" },
			}).getState().preset,
		).toBe("ask");
		expect(
			new StepPermissionController({
				env: { STEP_PERMISSION_PRESET: "strict" },
			}).getState().preset,
		).toBe("read-only");
	});

	it("resolves explicit preset and autopilot environment settings", () => {
		expect(
			resolveInitialStepPermissionPreset({
				env: { STEP_PERMISSION_PRESET: "read-only" },
			}),
		).toBe("read-only");
		expect(
			resolveInitialStepPermissionPreset({
				env: { STEP_PERMISSION_MODE: "auto" },
			}),
		).toBe("bypass");
		expect(resolveInitialStepPermissionPreset({ env: { STEP_AUTOPILOT: "1" } })).toBe("autopilot");
	});

	it("resolves the old Step approval triple and per-tool overrides", () => {
		expect(
			resolveInitialStepPermissionState({
				approvalMode: "auto",
				nonInteractiveApproval: "allow",
				autoResume: true,
				toolOverrides: { write_file: "deny" },
			}),
		).toMatchObject({
			preset: "autopilot",
			mode: "auto",
			nonInteractiveApproval: "allow",
			autoResume: true,
			toolOverrides: { write_file: "deny" },
		});
		const state = stepPermissionStateForPreset("ask");
		expect(decideStepToolCall("write_file", {}, state, { write_file: "allow" }).action).toBe("allow");
		expect(
			decideStepToolCall("write_file", { path: "x" }, state, {
				write_file: "confirm",
			}).action,
		).toBe("confirm");
		expect(
			resolveInitialStepPermissionState({
				env: {
					STEP_PERMISSION_PRESET: "autopilot",
					STEP_PERMISSION_MODE: "strict",
				},
			}),
		).toMatchObject({ preset: "autopilot", mode: "auto", autoResume: true });
		expect(
			resolveInitialStepPermissionState({
				env: {
					STEP_APPROVAL_MODE: "strict",
					STEP_PERMISSION_PRESET: "autopilot",
				},
			}),
		).toMatchObject({ preset: "read-only", mode: "strict", autoResume: false });
	});

	it("allows read tools, confirms writes, and blocks writes in read-only mode", () => {
		const ask = stepPermissionStateForPreset("ask");
		expect(decideStepToolCall("read_file", { path: "a.txt" }, ask).action).toBe("allow");
		expect(decideStepToolCall("search_web", { query: "current news" }, ask).action).toBe("allow");
		expect(decideStepToolCall("write_file", { path: "a.txt", content: "x" }, ask).action).toBe("confirm");
		const readOnly = stepPermissionStateForPreset("read-only");
		expect(decideStepToolCall("search_web", { query: "current news" }, readOnly).action).toBe("allow");
		expect(decideStepToolCall("write_file", { path: "a.txt", content: "x" }, readOnly).action).toBe("deny");
	});

	it("keeps dangerous commands behind confirmation even in bypass/autopilot", () => {
		for (const preset of ["bypass", "autopilot"] as const) {
			const decision = decideStepToolCall(
				"run_command",
				{ command: "rm -rf /etc" },
				stepPermissionStateForPreset(preset),
			);
			expect(decision.action).toBe("confirm");
			expect(decision.hazardous).toBe(true);
		}
		expect(isDangerousCommand("sudo -n reboot")).toBe(true);
		expect(isDangerousCommand("qemu-system-x86_64 -no-reboot -no-shutdown")).toBe(false);
		expect(containsDangerousLifecycleCommand("sh -c 'systemctl reboot'")).toBe(true);
	});

	it.each([true, false])("identifies each approval without changing the decision (approved=%s)", async (approved) => {
		const controller = new StepPermissionController({
			env: {},
			initialPreset: "ask",
		});
		const confirm = vi.fn(async () => approved);
		const signal = new AbortController().signal;
		const context = {
			hasUI: true,
			ui: { confirm },
			signal,
		} as unknown as ExtensionContext;
		const ids = ["chatcmpl-tool-first-12345678", "chatcmpl-tool-second-87654321"];
		for (const toolCallId of ids) {
			const result = await controller.handleToolCall(
				{
					type: "tool_call",
					toolName: "run_command",
					toolCallId,
					input: { command: "printf test" },
				},
				context,
			);
			expect(result).toEqual(approved ? undefined : { block: true, reason: "Tool call denied: run_command" });
		}
		expect(confirm).toHaveBeenCalledTimes(2);
		for (const toolCallId of ids) {
			expect(confirm).toHaveBeenCalledWith(
				expect.stringMatching(new RegExp(`run_command.*${toolCallId.slice(-8)}`, "u")),
				expect.stringContaining(toolCallId),
				{ signal, overlay: true },
			);
		}
		expect(confirm).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("separately"), {
			signal,
			overlay: true,
		});
	});

	it("keeps the hazard warning in an identifiable approval prompt", async () => {
		const controller = new StepPermissionController({
			env: {},
			initialPreset: "bypass",
		});
		const confirm = vi.fn(async () => false);
		const context = {
			hasUI: true,
			ui: { confirm },
		} as unknown as ExtensionContext;
		await controller.handleToolCall(
			{
				type: "tool_call",
				toolName: "run_command",
				toolCallId: "danger-12345678",
				input: { command: "rm -rf /etc" },
			},
			context,
		);
		expect(confirm).toHaveBeenCalledWith(
			expect.stringMatching(/dangerous.*run_command.*12345678/iu),
			expect.stringContaining("danger-12345678"),
			expect.objectContaining({ overlay: true }),
		);
	});

	it("honors non-interactive allow for ordinary confirmations but not hazards", async () => {
		const controller = new StepPermissionController({
			approvalMode: "confirm",
			nonInteractiveApproval: "allow",
		});
		const context = { hasUI: false } as never;
		const ordinary = await controller.handleToolCall(
			{ toolName: "write_file", input: { path: "x", content: "y" } } as never,
			context,
		);
		expect(ordinary).toBeUndefined();
		const dangerous = await controller.handleToolCall(
			{ toolName: "run_command", input: { command: "rm -rf /" } } as never,
			context,
		);
		expect(dangerous).toMatchObject({ block: true, terminate: true });
	});

	// Feedback issue-287bfff1a5fe7668: with the approval config removed entirely,
	// a non-interactive run inherited the interactive Bypass default and deleted
	// files with nobody watching.
	describe("unattended runs with no configured policy", () => {
		const noUI = { hasUI: false } as never;
		const writeCall = {
			toolName: "run_command",
			input: { command: "mkdir build" },
		} as never;

		it("marks an unselected policy as defaulted", () => {
			const state = resolveInitialStepPermissionState({ env: {} });
			expect(state.preset).toBe("bypass");
			expect(state.defaulted).toBe(true);
		});

		it("blocks a write when nothing configured the policy", async () => {
			const controller = new StepPermissionController({ env: {} });
			const result = await controller.handleToolCall(writeCall, noUI);
			expect(result).toMatchObject({ block: true, terminate: true });
			expect((result as { reason: string }).reason).toContain("no permission preset is configured");
		});

		it("still reads safe tools when nothing configured the policy", async () => {
			const controller = new StepPermissionController({ env: {} });
			const result = await controller.handleToolCall(
				{ toolName: "read_file", input: { path: "README.md" } } as never,
				noUI,
			);
			expect(result).toBeUndefined();
		});

		it("keeps the interactive Bypass default when a UI exists", async () => {
			const controller = new StepPermissionController({ env: {} });
			const confirm = vi.fn(async () => true);
			const context = {
				hasUI: true,
				ui: { confirm },
			} as unknown as ExtensionContext;
			const result = await controller.handleToolCall(writeCall, context);
			expect(result).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		});

		it("honors an explicit STEP_PERMISSION_PRESET=bypass", async () => {
			const controller = new StepPermissionController({
				env: { STEP_PERMISSION_PRESET: "bypass" },
			});
			expect(controller.getState().defaulted).toBeUndefined();
			expect(await controller.handleToolCall(writeCall, noUI)).toBeUndefined();
		});

		it("honors a trusted project preset injected as initialPreset", async () => {
			const controller = new StepPermissionController({
				env: {},
				initialPreset: "bypass",
			});
			expect(controller.getState().defaulted).toBeUndefined();
			expect(await controller.handleToolCall(writeCall, noUI)).toBeUndefined();
		});

		it("honors an explicit non-interactive allow without a preset", async () => {
			const controller = new StepPermissionController({
				env: {},
				nonInteractiveApproval: "allow",
			});
			expect(controller.getState().defaulted).toBeUndefined();
			expect(await controller.handleToolCall(writeCall, noUI)).toBeUndefined();
		});

		// An explicit `--non-interactive-approval deny` used to be worse than
		// passing nothing: it cleared the defaulted marker and the mode stayed
		// `auto`, where the fallback is never consulted, so the call ran.
		it("honors an explicit non-interactive deny under the bypass default", async () => {
			const controller = new StepPermissionController({
				env: {},
				nonInteractiveApproval: "deny",
			});
			const result = await controller.handleToolCall(writeCall, noUI);
			expect(result).toMatchObject({ block: true, terminate: true });
		});

		it("keeps an explicit deny blocking even with an explicit bypass preset", async () => {
			const controller = new StepPermissionController({
				env: {},
				initialPreset: "bypass",
				nonInteractiveApproval: "deny",
			});
			expect(await controller.handleToolCall(writeCall, noUI)).toMatchObject({
				block: true,
			});
		});

		it("leaves --approval-mode auto authorizing unattended writes", async () => {
			const controller = new StepPermissionController({
				env: {},
				approvalMode: "auto",
			});
			expect(await controller.handleToolCall(writeCall, noUI)).toBeUndefined();
		});

		it("keeps read-only mode denying with its own reason", async () => {
			const controller = new StepPermissionController({
				env: {},
				approvalMode: "strict",
			});
			const result = await controller.handleToolCall(writeCall, noUI);
			expect((result as { reason: string }).reason).toContain("Read-only mode blocks");
		});

		// A block that ends the run is the only thing a non-interactive caller sees,
		// so it has to say how to permit the call, and the advice differs by cause.
		it("tells an unconfigured run how to grant access", async () => {
			const controller = new StepPermissionController({ env: {} });
			const result = await controller.handleToolCall(writeCall, noUI);
			const reason = (result as { reason: string }).reason;
			expect(reason).toContain("no permission preset is configured");
			expect(reason).toContain("--non-interactive-approval allow");
			expect(reason).toContain("--approval-mode auto");
			// Guidance stays on CLI flags: env vars and config keys are not offered.
			expect(reason).not.toContain("STEP_PERMISSION_PRESET");
			expect(reason).not.toContain("config.toml");
		});

		it("tells a refusing policy how to lift it, not that nothing is configured", async () => {
			const controller = new StepPermissionController({
				env: {},
				nonInteractiveApproval: "deny",
			});
			const reason = ((await controller.handleToolCall(writeCall, noUI)) as { reason: string }).reason;
			expect(reason).toContain("denies unattended approvals");
			expect(reason).toContain("--non-interactive-approval allow");
			expect(reason).not.toContain("no permission preset is configured");
		});

		it("never advertises a flag for a dangerous command, because none works", async () => {
			const controller = new StepPermissionController({
				env: {},
				nonInteractiveApproval: "allow",
			});
			const dangerous = {
				toolName: "run_command",
				input: { command: "rm -rf /" },
			} as never;
			const reason = ((await controller.handleToolCall(dangerous, noUI)) as { reason: string }).reason;
			expect(reason).toContain("no flag or preset overrides that");
			expect(reason).not.toContain("--approval-mode auto");
			expect(reason).not.toContain("--tool-override");
		});

		it("drops the defaulted marker once a preset is chosen", () => {
			const controller = new StepPermissionController({ env: {} });
			expect(controller.getState().defaulted).toBe(true);
			controller.setPreset("bypass");
			expect(controller.getState().defaulted).toBeUndefined();
		});
	});
});

describe("Step autopilot continuation", () => {
	it("schedules one bounded continuation and stops on the same failure", () => {
		const timers: Array<() => void> = [];
		const resume = vi.fn();
		const announce = vi.fn();
		const telemetry = vi.fn();
		const controller = new StepAutoResumeController({
			isEnabled: () => true,
			canResume: () => true,
			resume,
			announce,
			onTelemetry: telemetry,
			delaysMs: [0, 0],
			setTimer: (callback) => {
				timers.push(callback);
				return timers.length as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer: vi.fn(),
		});
		const failed = {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "network down",
				},
			],
		} as never;
		controller.handleAgentEnd(failed);
		controller.handleAgentSettled();
		expect(timers).toHaveLength(1);
		timers.shift()!();
		expect(resume).toHaveBeenCalledWith(AUTO_RESUME_PROMPT);
		expect(telemetry).toHaveBeenCalledWith({
			outcome: "resumed",
			trigger: "model_error",
			probeStatus: "not_run",
			probeAttempts: 0,
			consecutiveResumes: 1,
			giveUpReason: "",
		});

		controller.handleAgentEnd(failed);
		controller.handleAgentSettled();
		expect(announce).toHaveBeenCalledWith("Autopilot stopped because the same error repeated");
		expect(telemetry).toHaveBeenCalledWith({
			outcome: "gave_up",
			trigger: "model_error",
			probeStatus: "not_run",
			probeAttempts: 0,
			consecutiveResumes: 1,
			giveUpReason: "same_failure",
		});
	});

	it("does not schedule when disabled or when the run has pending work", () => {
		const setTimer = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>);
		const controller = new StepAutoResumeController({
			isEnabled: () => false,
			canResume: () => false,
			resume: vi.fn(),
			setTimer,
		});
		controller.handleAgentEnd({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "failed" }],
		} as never);
		controller.handleAgentSettled();
		expect(setTimer).not.toHaveBeenCalled();
	});

	it("cancels stale failures and reports a rejected continuation", async () => {
		const timers: Array<() => void> = [];
		const announce = vi.fn();
		const controller = new StepAutoResumeController({
			isEnabled: () => true,
			canResume: () => true,
			resume: async () => {
				throw new Error("session closed");
			},
			announce,
			delaysMs: [0],
			setTimer: (callback) => {
				timers.push(callback);
				return timers.length as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer: vi.fn(),
		});
		const failed = {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "network down",
				},
			],
		} as never;

		controller.handleAgentEnd(failed);
		controller.handleAgentSettled();
		controller.cancel();
		timers.shift()?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(announce).not.toHaveBeenCalledWith(expect.stringContaining("could not resume"));

		controller.handleAgentEnd(failed);
		controller.handleAgentSettled();
		timers.shift()?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(announce).toHaveBeenCalledWith("Autopilot could not resume: session closed");
	});
});
