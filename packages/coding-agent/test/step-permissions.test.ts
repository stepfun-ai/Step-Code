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
		const controller = new StepPermissionController({ env: {}, initialPreset: "ask" });
		const confirm = vi.fn(async () => approved);
		const signal = new AbortController().signal;
		const context = { hasUI: true, ui: { confirm }, signal } as unknown as ExtensionContext;
		const ids = ["chatcmpl-tool-first-12345678", "chatcmpl-tool-second-87654321"];
		for (const toolCallId of ids) {
			const result = await controller.handleToolCall(
				{ type: "tool_call", toolName: "run_command", toolCallId, input: { command: "printf test" } },
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
		const controller = new StepPermissionController({ env: {}, initialPreset: "bypass" });
		const confirm = vi.fn(async () => false);
		const context = { hasUI: true, ui: { confirm } } as unknown as ExtensionContext;
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
