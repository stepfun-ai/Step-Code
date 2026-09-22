import { describe, expect, test, vi } from "vitest";
import type {
	BeforeProviderHeadersEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "../src/core/extensions/types.ts";
import { createStepExtension, stepExtension } from "../src/features/step.ts";
import { STEP_INIT_PROMPT } from "../src/step/init-prompt.ts";

function commandContext(isIdle: boolean): ExtensionCommandContext {
	return {
		isIdle: () => isIdle,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
	} as unknown as ExtensionCommandContext;
}

describe("Step extension", () => {
	test.each([
		{ name: "selected non-Bash interpreter", shellPath: process.execPath, prefix: undefined },
		{ name: "executed command prefix", shellPath: undefined, prefix: "rm -rf ./build" },
	])("uses the real shell settings for approval: $name", async ({ shellPath, prefix }) => {
		const on = vi.fn();
		createStepExtension({
			permission: { env: {}, initialPreset: "bypass", nonInteractiveApproval: "allow" },
			stepSettings: () => ({
				getStepSettings: () => ({}),
				setEffectiveStepSettings: vi.fn(),
				getShellPath: () => shellPath,
				getShellCommandPrefix: () => prefix,
			}),
		})({
			registerProvider: vi.fn(),
			on,
			registerCommand: vi.fn(),
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);
		const handler = on.mock.calls.find(([name]) => name === "tool_call")?.[1] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		expect(
			await handler(
				{
					type: "tool_call",
					toolName: "run_command",
					toolCallId: "shell-settings",
					input: { command: "printf safe" },
				},
				{ hasUI: false },
			),
		).toMatchObject({ block: true, terminate: true });
	});

	test("does not register the removed /effort alias", () => {
		const registerCommand = vi.fn();
		createStepExtension()({
			registerProvider: vi.fn(),
			on: vi.fn(),
			registerCommand,
			setThinkingLevel: vi.fn(),
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);

		expect(registerCommand.mock.calls.find(([name]) => name === "effort")).toBeUndefined();
	});

	test("routes /init through pi's user-message path", async () => {
		const sendUserMessage = vi.fn();
		const registerCommand = vi.fn();
		stepExtension({
			registerProvider: vi.fn(),
			on: vi.fn(),
			registerCommand,
			sendUserMessage,
		} as unknown as ExtensionAPI);

		const command = registerCommand.mock.calls.find(([name]) => name === "init")?.[1] as {
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		};
		await command.handler("", commandContext(true));

		expect(sendUserMessage).toHaveBeenCalledWith(STEP_INIT_PROMPT);
	});

	test("does not submit /init while pi is busy", async () => {
		const sendUserMessage = vi.fn();
		const registerCommand = vi.fn();
		stepExtension({
			registerProvider: vi.fn(),
			on: vi.fn(),
			registerCommand,
			sendUserMessage,
		} as unknown as ExtensionAPI);

		const command = registerCommand.mock.calls.find(([name]) => name === "init")?.[1] as {
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		};
		const ctx = commandContext(false);
		await command.handler("", ctx);

		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Wait for the current work to finish before initializing AGENTS.md",
			"warning",
		);
	});

	test("keeps only the plural permissions command and no removed aliases", () => {
		const registerCommand = vi.fn();
		stepExtension({
			registerProvider: vi.fn(),
			on: vi.fn(),
			registerCommand,
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);

		expect(registerCommand.mock.calls.find(([name]) => name === "permission")).toBeUndefined();
		expect(registerCommand.mock.calls.find(([name]) => name === "permissions")).toBeDefined();
		expect(registerCommand.mock.calls.find(([name]) => name === "mode")).toBeUndefined();
	});

	test("reports permission toggles and unrecognized slash input without arguments", async () => {
		const on = vi.fn();
		const registerCommand = vi.fn();
		const track = vi.fn();
		createStepExtension({ telemetry: { track } })({
			registerProvider: vi.fn(),
			on,
			registerCommand,
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);

		const command = registerCommand.mock.calls.find(([name]) => name === "permissions")?.[1] as {
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		};
		await command.handler("bypass", commandContext(true));

		const inputHandler = on.mock.calls.find(([name]) => name === "input")?.[1] as (
			event: { text: string },
			ctx: ExtensionContext,
		) => unknown;
		await inputHandler({ text: "/unknown secret argument" }, {} as ExtensionContext);

		expect(track).toHaveBeenCalledWith(
			"slash_command_used",
			{ command: "/permissions", recognized: true },
			undefined,
		);
		expect(track).toHaveBeenCalledWith("permission_mode_toggled", { mode: "bypass", source: "command" }, undefined);
		expect(track).toHaveBeenCalledWith("slash_command_used", { command: "/unknown", recognized: false }, undefined);
	});

	test("passes explicit CLI approval options into the native tool-call hook", async () => {
		const on = vi.fn();
		createStepExtension({
			permission: {
				approvalMode: "confirm",
				nonInteractiveApproval: "allow",
				toolOverrides: { write_file: "deny" },
			},
		})({
			registerProvider: vi.fn(),
			on,
			registerCommand: vi.fn(),
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);

		const handler = on.mock.calls.find(([name]) => name === "tool_call")?.[1] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const result = await handler({ toolName: "write_file", input: { path: "x", content: "y" } }, { hasUI: false });
		expect(result).toMatchObject({ block: true, terminate: true });
	});

	test("restores and persists the Step approval triple through the settings decorator", async () => {
		const on = vi.fn();
		const registerCommand = vi.fn();
		const setEffectiveStepSettings = vi.fn();
		const settings = {
			getStepSettings: () => ({
				permissionPreset: "bypass" as const,
				approvalMode: "auto" as const,
				nonInteractiveApproval: "allow" as const,
				autoResume: false,
			}),
			setEffectiveStepSettings,
		};
		createStepExtension({ stepSettings: () => settings })({
			registerProvider: vi.fn(),
			on,
			registerCommand,
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);

		const toolHandler = on.mock.calls.find(([name]) => name === "tool_call")?.[1] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		expect(
			await toolHandler({ toolName: "write_file", input: { path: "x", content: "y" } }, { hasUI: false }),
		).toBeUndefined();

		const command = registerCommand.mock.calls.find(([name]) => name === "permissions")?.[1] as {
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		};
		await command.handler("autopilot", commandContext(true));
		expect(setEffectiveStepSettings).toHaveBeenCalledWith({
			permissionPreset: "autopilot",
			approvalMode: "auto",
			nonInteractiveApproval: "allow",
			autoResume: true,
		});
	});

	test.each(["bypass", "autopilot"] as const)(
		"keeps recursive forced removal gated through the %s tool-call hook",
		async (initialPreset) => {
			const on = vi.fn();
			createStepExtension({
				permission: { env: {}, initialPreset, toolOverrides: { run_command: "allow" } },
			})({
				registerProvider: vi.fn(),
				on,
				registerCommand: vi.fn(),
				sendUserMessage: vi.fn(),
			} as unknown as ExtensionAPI);
			const handler = on.mock.calls.find(([name]) => name === "tool_call")?.[1] as (
				event: unknown,
				ctx: unknown,
			) => Promise<unknown>;
			const event = {
				type: "tool_call",
				toolName: "run_command",
				toolCallId: "remove-build",
				input: { command: "rm -rf ./build" },
			};
			const confirm = vi.fn(async () => false);
			expect(await handler(event, { hasUI: true, ui: { confirm } })).toMatchObject({ block: true });
			expect(confirm).toHaveBeenCalledOnce();
			expect(await handler(event, { hasUI: false })).toMatchObject({ block: true, terminate: true });
		},
	);

	// The Shift+Tab shortcut is an in-the-moment gesture by someone watching the
	// session. Persisting it also wrote `nonInteractiveApproval: "allow"`, which
	// granted every later `--print` run in that project unattended write access.
	test("does not persist the Shift+Tab permission cycle", async () => {
		const on = vi.fn();
		const registerCommand = vi.fn();
		const setEffectiveStepSettings = vi.fn();
		const settings = { getStepSettings: () => ({}), setEffectiveStepSettings };
		createStepExtension({ stepSettings: () => settings })({
			registerProvider: vi.fn(),
			on,
			registerCommand,
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);

		const command = registerCommand.mock.calls.find(([name]) => name === "permissions")?.[1] as {
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		};
		await command.handler("--cycle", commandContext(true));
		expect(setEffectiveStepSettings).not.toHaveBeenCalled();

		// A named preset is a deliberate choice and still persists.
		await command.handler("read-only", commandContext(true));
		expect(setEffectiveStepSettings).toHaveBeenCalledWith(expect.objectContaining({ permissionPreset: "read-only" }));
	});

	test("keeps explicit environment policy ahead of persisted Step settings", async () => {
		const previousPreset = process.env.STEP_PERMISSION_PRESET;
		process.env.STEP_PERMISSION_PRESET = "ask";
		try {
			const on = vi.fn();
			const settings = {
				getStepSettings: () => ({
					permissionPreset: "autopilot" as const,
					approvalMode: "auto" as const,
					nonInteractiveApproval: "allow" as const,
					autoResume: true,
				}),
				setEffectiveStepSettings: vi.fn(),
			};
			createStepExtension({ stepSettings: () => settings })({
				registerProvider: vi.fn(),
				on,
				registerCommand: vi.fn(),
				sendUserMessage: vi.fn(),
			} as unknown as ExtensionAPI);
			const handler = on.mock.calls.find(([name]) => name === "tool_call")?.[1] as (
				event: unknown,
				ctx: unknown,
			) => Promise<unknown>;
			expect(
				await handler({ toolName: "write_file", input: { path: "x", content: "y" } }, { hasUI: false }),
			).toMatchObject({ block: true, terminate: true });
		} finally {
			if (previousPreset === undefined) delete process.env.STEP_PERMISSION_PRESET;
			else process.env.STEP_PERMISSION_PRESET = previousPreset;
		}
	});

	test("keeps an explicit false auto-resume value ahead of persisted autopilot", () => {
		const on = vi.fn();
		const setStatus = vi.fn();
		createStepExtension({
			permission: { autoResume: false },
			stepSettings: () => ({
				getStepSettings: () => ({
					permissionPreset: "autopilot",
					approvalMode: "auto",
					nonInteractiveApproval: "allow",
					autoResume: true,
				}),
				setEffectiveStepSettings: vi.fn(),
			}),
		})({
			registerProvider: vi.fn(),
			on,
			registerCommand: vi.fn(),
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);

		const sessionStart = on.mock.calls.filter(([name]) => name === "session_start").at(-1)?.[1] as (
			event: unknown,
			ctx: unknown,
		) => void;
		sessionStart(
			{ type: "session_start", reason: "new" },
			{
				ui: { notify: vi.fn(), setStatus },
				autoRetryEnabled: false,
				setAutoRetryEnabled: vi.fn(),
			},
		);
		expect(setStatus).toHaveBeenCalledWith("step-permission", "Mode: Bypass");
	});

	test("rehydrates project policy after the trust probe", async () => {
		const on = vi.fn();
		let persisted: "ask" | "autopilot" = "ask";
		const settings = {
			getStepSettings: () =>
				persisted === "ask"
					? {
							permissionPreset: "ask" as const,
							approvalMode: "confirm" as const,
							nonInteractiveApproval: "deny" as const,
							autoResume: false,
						}
					: {
							permissionPreset: "autopilot" as const,
							approvalMode: "auto" as const,
							nonInteractiveApproval: "allow" as const,
							autoResume: true,
						},
			setEffectiveStepSettings: vi.fn(),
		};
		createStepExtension({ stepSettings: () => settings })({
			registerProvider: vi.fn(),
			on,
			registerCommand: vi.fn(),
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);
		const toolHandler = on.mock.calls.find(([name]) => name === "tool_call")?.[1] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const sessionStart = on.mock.calls.filter(([name]) => name === "session_start").at(-1)?.[1] as (
			event: unknown,
			ctx: unknown,
		) => void;

		const writeCall = {
			toolName: "write_file",
			input: { path: "x", content: "y" },
		};
		expect(await toolHandler(writeCall, { hasUI: false })).toMatchObject({
			block: true,
			terminate: true,
		});
		persisted = "autopilot";
		sessionStart(
			{ type: "session_start", reason: "new" },
			{
				ui: { notify: vi.fn(), setStatus: vi.fn() },
				autoRetryEnabled: false,
				setAutoRetryEnabled: vi.fn(),
			},
		);
		expect(await toolHandler(writeCall, { hasUI: false })).toBeUndefined();
	});

	test("limits trace headers to configured cloud-trace model requests", async () => {
		const on = vi.fn();
		createStepExtension({
			traceHeaderPolicy: {
				allowedBaseUrls: ["https://trace.example.test/v1"],
				highSensitivityFields: ["session-id", "workspace-id", "provider-id", "model"],
			},
		})({
			registerProvider: vi.fn(),
			on,
			registerCommand: vi.fn(),
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);

		const handler = on.mock.calls.find(([name]) => name === "before_provider_headers")?.[1] as (
			event: BeforeProviderHeadersEvent,
			ctx: Pick<ExtensionContext, "model" | "cwd" | "sessionManager">,
		) => void;

		const headers = {} as Record<string, string | null>;
		await handler({ type: "before_provider_headers", headers }, {
			model: {
				provider: "step",
				id: "step-3.7-flash",
				baseUrl: "https://api.stepfun.com/step_plan/v1",
			},
			cwd: "/workspace",
			sessionManager: { getSessionId: () => "session-1" },
		} as unknown as Pick<ExtensionContext, "model" | "cwd" | "sessionManager">);
		// The native Step endpoint is a direct model API, not the cloud-trace
		// collector. Keep session/workspace identifiers off custom or direct
		// provider requests; only the low-sensitivity client marker is universal.
		expect(headers).toEqual({ "x-step-client": "cli" });

		const originalOrigin = process.env.STEPCODE_CLOUD_TRACE_ORIGIN;
		process.env.STEPCODE_CLOUD_TRACE_ORIGIN = "https://trace.example.test/v1";
		try {
			const otherHeaders: Record<string, string | null> = {};
			await handler({ type: "before_provider_headers", headers: otherHeaders }, {
				model: {
					provider: "stepfunModelProxy",
					id: "step-proxy",
					baseUrl: "https://trace.example.test/v1/chat/completions",
				},
				cwd: "/workspace",
				sessionManager: { getSessionId: () => "session-2" },
			} as unknown as Pick<ExtensionContext, "model" | "cwd" | "sessionManager">);
			expect(otherHeaders).toMatchObject({
				"x-step-client": "cli",
				"x-step-session-id": "session-2",
				"x-step-workspace-id": "/workspace",
				"x-step-provider-id": "stepfunModelProxy",
				"x-step-model": "step-proxy",
			});
		} finally {
			if (originalOrigin === undefined) delete process.env.STEPCODE_CLOUD_TRACE_ORIGIN;
			else process.env.STEPCODE_CLOUD_TRACE_ORIGIN = originalOrigin;
		}
	});
});
