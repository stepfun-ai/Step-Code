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
	it("exposes the three stable presets in cycle order", () => {
		expect(STEP_PERMISSION_PRESETS.map((preset) => preset.id)).toEqual(["ask", "approve-for-me", "full-access"]);
		const controller = new StepPermissionController({ env: {} });
		expect(controller.getState().preset).toBe("approve-for-me");
		expect(controller.cycle().preset).toBe("full-access");
		expect(controller.cycle().preset).toBe("ask");
		expect(controller.cycle().preset).toBe("approve-for-me");
		expect(controller.nextPresetId()).toBe("full-access");
		expect(
			new StepPermissionController({
				env: { STEP_PERMISSION_PRESET: "confirm" },
			}).getState().preset,
		).toBe("ask");
		expect(
			new StepPermissionController({
				env: { STEP_PERMISSION_PRESET: "strict" },
			}).getState().preset,
		).toBe("ask");
	});

	it("normalizes retired preset ids onto the remaining tiers", () => {
		// Every retired tier returns to Ask until the user chooses a new tier.
		for (const legacy of ["bypass", "auto", "autopilot", "bypasspermissions"]) {
			expect(resolveInitialStepPermissionPreset({ env: { STEP_PERMISSION_PRESET: legacy } })).toBe("ask");
		}
		for (const legacy of ["read-only", "readonly", "strict"]) {
			expect(resolveInitialStepPermissionPreset({ env: { STEP_PERMISSION_PRESET: legacy } })).toBe("ask");
		}
		for (const alias of ["full-access", "fullaccess", "full", "yolo", "never-ask"]) {
			expect(resolveInitialStepPermissionPreset({ env: { STEP_PERMISSION_PRESET: alias } })).toBe("full-access");
		}
	});

	it("resolves explicit preset and autopilot environment settings", () => {
		expect(
			resolveInitialStepPermissionPreset({
				env: { STEP_PERMISSION_PRESET: "read-only" },
			}),
		).toBe("ask");
		expect(
			resolveInitialStepPermissionPreset({
				env: { STEP_PERMISSION_MODE: "auto" },
			}),
		).toBe("ask");
		expect(resolveInitialStepPermissionPreset({ env: { STEP_AUTOPILOT: "1" } })).toBe("ask");
	});

	it("resets legacy autopilot to Ask and enables auto-resume for newly selected automatic tiers", () => {
		expect(
			resolveInitialStepPermissionState({
				env: { STEP_PERMISSION_PRESET: "autopilot" },
			}),
		).toMatchObject({ preset: "ask", mode: "confirm", autoResume: false });
		expect(resolveInitialStepPermissionState({ env: { STEP_AUTOPILOT: "1" } })).toMatchObject({
			preset: "ask",
			autoResume: false,
		});
		expect(resolveInitialStepPermissionState({ env: { STEP_AUTO_RESUME: "1" } })).toMatchObject({
			preset: "approve-for-me",
			autoResume: true,
		});
	});

	it("keeps Full Access labeled Full Access when auto-resume or an unattended deny is also set", () => {
		// Approve for Me and Full Access share the (mode, approval) pair, so the
		// relabeling must not rename a Full Access state that also requests
		// auto-resume or refuses unattended approvals.
		for (const env of [
			{ STEP_PERMISSION_PRESET: "full-access", STEP_AUTO_RESUME: "1" },
			{ STEP_PERMISSION_PRESET: "full-access", STEP_NON_INTERACTIVE_APPROVAL: "deny" },
		]) {
			const state = resolveInitialStepPermissionState({ env });
			expect(state).toMatchObject({ preset: "full-access", skipCommandPolicy: true });
			expect(decideStepToolCall("run_command", { command: "rm -rf /etc" }, state).action).toBe("allow");
		}
		expect(
			resolveInitialStepPermissionState({
				initialPreset: "full-access",
				autoResume: true,
				env: {},
			}),
		).toMatchObject({ preset: "full-access", skipCommandPolicy: true, autoResume: true });
	});

	it("maps the retired plan vocabulary onto Ask", () => {
		expect(resolveInitialStepPermissionPreset({ env: { STEP_PERMISSION_PRESET: "plan" } })).toBe("ask");
		expect(resolveInitialStepPermissionPreset({ env: { STEP_PERMISSION_MODE: "plan" } })).toBe("ask");
		expect(resolveInitialStepPermissionState({ env: { STEP_APPROVAL_MODE: "acceptedits" } })).toMatchObject({
			preset: "ask",
			mode: "confirm",
		});
	});

	it("does not grant unattended writes just because STEP_AUTO_RESUME is enabled", async () => {
		const controller = new StepPermissionController({ env: { STEP_AUTO_RESUME: "1" } });
		expect(controller.getState().defaulted).toBe(true);
		expect(
			await controller.handleToolCall(
				{
					type: "tool_call",
					toolName: "write_file",
					toolCallId: "resume-only",
					input: { path: "x", content: "x" },
				},
				{ hasUI: false } as ExtensionContext,
			),
		).toMatchObject({ block: true, terminate: true });
	});

	it("uses automatic tier defaults on deliberate selection after a legacy disabled auto-resume", () => {
		const controller = new StepPermissionController({
			env: { STEP_PERMISSION_PRESET: "autopilot" },
			autoResume: false,
		});
		expect(controller.getState().autoResume).toBe(false);
		expect(controller.setPreset("full-access")?.autoResume).toBe(true);
		const legacy = new StepPermissionController({ env: { STEP_PERMISSION_PRESET: "autopilot" } });
		expect(legacy.setPreset("full-access")?.autoResume).toBe(true);
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
			preset: "approve-for-me",
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
		).toMatchObject({ preset: "ask", mode: "confirm", autoResume: false });
		expect(
			resolveInitialStepPermissionState({
				env: {
					STEP_APPROVAL_MODE: "strict",
					STEP_PERMISSION_PRESET: "autopilot",
				},
			}),
		).toMatchObject({ preset: "ask", mode: "confirm", autoResume: false });
	});

	it("allows read tools and confirms writes under Ask", () => {
		const ask = stepPermissionStateForPreset("ask");
		expect(decideStepToolCall("read_file", { path: "a.txt" }, ask).action).toBe("allow");
		expect(decideStepToolCall("search_web", { query: "current news" }, ask).action).toBe("allow");
		expect(decideStepToolCall("write_file", { path: "a.txt", content: "x" }, ask).action).toBe("confirm");
		const approveForMe = stepPermissionStateForPreset("approve-for-me");
		expect(decideStepToolCall("write_file", { path: "a.txt", content: "x" }, approveForMe).action).toBe("allow");
	});

	it("keeps dangerous commands behind confirmation except under Full Access", () => {
		for (const preset of ["ask", "approve-for-me"] as const) {
			const decision = decideStepToolCall(
				"run_command",
				{ command: "rm -rf /etc" },
				stepPermissionStateForPreset(preset),
			);
			expect(decision.action).toBe("confirm");
			expect(decision.hazardous).toBe(true);
		}
		const fused = decideStepToolCall(
			"write_file",
			{ path: "a.txt", content: "x", then_run: "rm -rf /etc" },
			stepPermissionStateForPreset("approve-for-me"),
		);
		expect(fused.action).toBe("confirm");
		expect(fused.hazardous).toBe(true);
		expect(fused.reason).toContain("then_run: rm -rf /etc");
		// Full Access is the only tier that runs detected dangerous commands, and
		// the only behavioral difference from Approve for Me.
		const fullAccess = stepPermissionStateForPreset("full-access");
		expect(fullAccess.skipCommandPolicy).toBe(true);
		expect(decideStepToolCall("run_command", { command: "rm -rf /etc" }, fullAccess).action).toBe("allow");
		expect(
			decideStepToolCall("write_file", { path: "a.txt", content: "x", then_run: "rm -rf /etc" }, fullAccess).action,
		).toBe("allow");
		expect(isDangerousCommand("sudo -n reboot")).toBe(true);
		expect(isDangerousCommand("qemu-system-x86_64 -no-reboot -no-shutdown")).toBe(false);
		expect(containsDangerousLifecycleCommand("sh -c 'systemctl reboot'")).toBe(true);
	});

	it("keeps explicit tool denials and unresolved analysis distinct under Full Access", () => {
		const fullAccess = stepPermissionStateForPreset("full-access");
		// An explicit per-tool deny is a user-configured block, not a confirmation.
		expect(
			decideStepToolCall("run_command", { command: "rm -rf /etc" }, fullAccess, { run_command: "deny" }).action,
		).toBe("deny");
		// Incomplete analysis runs too: Full Access asks nothing.
		expect(decideStepToolCall("run_command", { command: '"$HOME/x" sync' }, fullAccess).action).toBe("allow");
		// Approve for Me still confirms the same unanalyzable command.
		expect(
			decideStepToolCall(
				"run_command",
				{ command: '"$HOME/x" sync' },
				stepPermissionStateForPreset("approve-for-me"),
			).action,
		).toBe("confirm");
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
			initialPreset: "approve-for-me",
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

	describe("non-interactive denial recovery", () => {
		const noUI = { hasUI: false } as never;
		const hazardousCall = {
			toolName: "run_command",
			input: { command: "rm -rf ./build" },
		} as never;

		it("blocks a hazardous command without terminating when denial is continue", async () => {
			const controller = new StepPermissionController({
				approvalMode: "auto",
				nonInteractiveApproval: "allow",
				nonInteractiveDenial: "continue",
				env: {},
			});
			const result = await controller.handleToolCall(hazardousCall, noUI);
			expect(result).toMatchObject({ block: true });
			expect((result as { terminate?: boolean }).terminate).toBeUndefined();
			expect((result as { reason: string }).reason).toContain("was not executed");
		});

		it("resolves continue from the environment", async () => {
			const controller = new StepPermissionController({
				approvalMode: "auto",
				nonInteractiveApproval: "allow",
				env: { STEP_NON_INTERACTIVE_DENIAL: "continue" },
			});
			const result = await controller.handleToolCall(hazardousCall, noUI);
			expect(result).toMatchObject({ block: true });
			expect((result as { terminate?: boolean }).terminate).toBeUndefined();
		});

		it("still terminates by default and on unrecognized values", async () => {
			for (const env of [{}, { STEP_NON_INTERACTIVE_DENIAL: "recover" }]) {
				const controller = new StepPermissionController({
					approvalMode: "auto",
					nonInteractiveApproval: "allow",
					env,
				});
				expect(await controller.handleToolCall(hazardousCall, noUI)).toMatchObject({
					block: true,
					terminate: true,
				});
			}
		});

		it("does not approve anything: incomplete analysis stays blocked", async () => {
			const controller = new StepPermissionController({
				approvalMode: "auto",
				nonInteractiveApproval: "allow",
				nonInteractiveDenial: "continue",
				env: {},
			});
			const result = await controller.handleToolCall(
				{ toolName: "run_command", input: { command: "eval $unresolved" } } as never,
				noUI,
			);
			expect(result).toMatchObject({ block: true });
			expect((result as { terminate?: boolean }).terminate).toBeUndefined();
		});

		it.each([
			["unsupported-shell", { shellPath: process.execPath }],
			["shell-configuration", { shellPath: `${process.cwd()}/.missing-step-shell` }],
		])("terminates environmental analysis failures in continue mode (%s)", async (reason, shellContext) => {
			const controller = new StepPermissionController({
				approvalMode: "auto",
				nonInteractiveApproval: "allow",
				nonInteractiveDenial: "continue",
				shellContext: () => shellContext,
				env: {},
			});
			const result = await controller.handleToolCall(
				{ toolName: "run_command", input: { command: "printf safe" } } as never,
				noUI,
			);
			expect(result).toMatchObject({ block: true, terminate: true });
			expect((result as { reason: string }).reason).toContain(reason);
		});

		it("keeps explicit denials terminating even with continue", async () => {
			const overridden = new StepPermissionController({
				initialPreset: "approve-for-me",
				nonInteractiveDenial: "continue",
				toolOverrides: { run_command: "deny" },
				env: {},
			});
			expect(await overridden.handleToolCall(hazardousCall, noUI)).toMatchObject({
				block: true,
				terminate: true,
			});
		});

		it("keeps refused-policy guidance in continue mode", async () => {
			const controller = new StepPermissionController({
				approvalMode: "confirm",
				nonInteractiveApproval: "deny",
				nonInteractiveDenial: "continue",
				env: {},
			});
			const result = await controller.handleToolCall(
				{ toolName: "write_file", input: { path: "x", content: "y" } } as never,
				noUI,
			);
			expect(result).toMatchObject({ block: true });
			expect((result as { terminate?: boolean }).terminate).toBeUndefined();
			const reason = (result as { reason: string }).reason;
			expect(reason).toContain("--non-interactive-approval allow");
			expect(reason).toContain("--approval-mode auto");
		});

		it("keeps unconfigured-policy guidance in continue mode", async () => {
			const controller = new StepPermissionController({
				nonInteractiveDenial: "continue",
				env: {},
			});
			const result = await controller.handleToolCall(
				{ toolName: "write_file", input: { path: "x", content: "y" } } as never,
				noUI,
			);
			expect(result).toMatchObject({ block: true });
			expect((result as { terminate?: boolean }).terminate).toBeUndefined();
			const reason = (result as { reason: string }).reason;
			expect(reason).toContain("--non-interactive-approval allow");
			expect(reason).toContain("--approval-mode auto");
		});
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
			expect(state.preset).toBe("approve-for-me");
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

		it("keeps the interactive automatic default when a UI exists", async () => {
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

		it("honors an explicit STEP_PERMISSION_PRESET=approve-for-me", async () => {
			const controller = new StepPermissionController({
				env: { STEP_PERMISSION_PRESET: "approve-for-me" },
			});
			expect(controller.getState().defaulted).toBeUndefined();
			expect(await controller.handleToolCall(writeCall, noUI)).toBeUndefined();
		});

		it("requires a new selection for legacy STEP_PERMISSION_PRESET=bypass", async () => {
			const controller = new StepPermissionController({
				env: { STEP_PERMISSION_PRESET: "bypass" },
			});
			expect(controller.getState().preset).toBe("ask");
			expect(controller.getState().defaulted).toBeUndefined();
			expect(await controller.handleToolCall(writeCall, noUI)).toMatchObject({ block: true });
		});

		it("honors a trusted project preset injected as initialPreset", async () => {
			const controller = new StepPermissionController({
				env: {},
				initialPreset: "approve-for-me",
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
		it("honors an explicit non-interactive deny under the automatic default", async () => {
			const controller = new StepPermissionController({
				env: {},
				nonInteractiveApproval: "deny",
			});
			const result = await controller.handleToolCall(writeCall, noUI);
			expect(result).toMatchObject({ block: true, terminate: true });
		});

		it("keeps an explicit deny blocking even with an explicit approve-for-me preset", async () => {
			const controller = new StepPermissionController({
				env: {},
				initialPreset: "approve-for-me",
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

		it("maps the retired strict approval mode onto Ask", async () => {
			const controller = new StepPermissionController({
				env: { STEP_APPROVAL_MODE: "strict" },
			});
			expect(controller.getState()).toMatchObject({ preset: "ask", mode: "confirm" });
			const result = await controller.handleToolCall(writeCall, noUI);
			expect(result).toMatchObject({ block: true, terminate: true });
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
			controller.setPreset("approve-for-me");
			expect(controller.getState().defaulted).toBeUndefined();
		});

		it("enables auto-resume in both automatic tiers without an environment flag", () => {
			const controller = new StepPermissionController({ env: {}, initialPreset: "approve-for-me" });
			expect(controller.getState()).toMatchObject({ preset: "approve-for-me", autoResume: true });
			// Ask makes the flag inert but must not forget the request.
			expect(controller.setPreset("ask")).toMatchObject({ preset: "ask", autoResume: false });
			expect(controller.setPreset("approve-for-me")).toMatchObject({
				preset: "approve-for-me",
				autoResume: true,
			});
			expect(controller.setPreset("full-access")).toMatchObject({
				preset: "full-access",
				skipCommandPolicy: true,
				autoResume: true,
			});
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

	it("gates edit_file then_run as an embedded run_command call", () => {
		const approveForMe = stepPermissionStateForPreset("approve-for-me");
		const input = { path: "a.txt", search: "a", replace: "b", then_run: "npm test" };
		expect(decideStepToolCall("edit_file", input, approveForMe).action).toBe("allow");

		const denied = decideStepToolCall("edit_file", input, approveForMe, { run_command: "deny" });
		expect(denied.action).toBe("deny");
		expect(denied.reason).toContain("then_run (run_command)");

		const ask = decideStepToolCall("edit_file", input, stepPermissionStateForPreset("ask"));
		expect(ask.action).toBe("confirm");
		expect(ask.reason).toContain("then_run: npm test");

		// Full Access runs the fused call, dangerous verification command included.
		expect(
			decideStepToolCall(
				"edit_file",
				{ ...input, then_run: "rm -rf ./build" },
				stepPermissionStateForPreset("full-access"),
			).action,
		).toBe("allow");
	});
});
