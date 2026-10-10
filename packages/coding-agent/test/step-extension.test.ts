import { describe, expect, test, vi } from "vitest";
import type {
	BeforeProviderHeadersEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "../src/core/extensions/types.ts";
import { createStepExtension, stepExtension } from "../src/features/step.ts";
import { STEP_INIT_PROMPT } from "../src/step/init-prompt.ts";

function commandContext(
	isIdle: boolean,
	select?: (title: string, options: string[]) => Promise<string | undefined>,
): ExtensionCommandContext {
	return {
		isIdle: () => isIdle,
		ui: { notify: vi.fn(), setStatus: vi.fn(), select: select ?? (async () => undefined) },
	} as unknown as ExtensionCommandContext;
}

describe("Step extension", () => {
	test.each(["ask", "approve-for-me", "full-access"] as const)(
		"resumes model errors by default only in automatic tiers: %s",
		async (initialPreset) => {
			vi.useFakeTimers();
			try {
				const on = vi.fn();
				const sendUserMessage = vi.fn();
				createStepExtension({
					permission: { env: {}, initialPreset },
					stepSettings: () => ({
						getStepSettings: () => ({ fullAccessAcknowledged: true }),
						setEffectiveStepSettings: vi.fn(),
					}),
				})({ on, sendUserMessage, registerProvider: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI);
				const handler = (name: string) => on.mock.calls.filter(([event]) => event === name).at(-1)![1];
				const ctx = {
					hasUI: false,
					ui: { notify: vi.fn(), setStatus: vi.fn() },
					isIdle: () => true,
					hasPendingMessages: () => false,
					autoRetryEnabled: false,
					setAutoRetryEnabled: vi.fn(),
				};
				handler("session_start")({}, ctx);
				handler("agent_end")({
					messages: [{ role: "assistant", stopReason: "error", errorMessage: "network down" }],
				});
				handler("agent_settled")({}, ctx);
				await vi.advanceTimersByTimeAsync(5000);
				expect(sendUserMessage).toHaveBeenCalledTimes(initialPreset === "ask" ? 0 : 1);
				if (initialPreset !== "ask") expect(ctx.setAutoRetryEnabled).toHaveBeenCalledWith(true);
				handler("session_shutdown")({}, ctx);
			} finally {
				vi.useRealTimers();
			}
		},
	);
	test.each([
		{ name: "selected non-Bash interpreter", shellPath: process.execPath, prefix: undefined },
		{ name: "executed command prefix", shellPath: undefined, prefix: "rm -rf ./build" },
	])("uses the real shell settings for approval: $name", async ({ shellPath, prefix }) => {
		const on = vi.fn();
		createStepExtension({
			permission: { env: {}, initialPreset: "approve-for-me", nonInteractiveApproval: "allow" },
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
		await command.handler("approve-for-me", commandContext(true));

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
		expect(track).toHaveBeenCalledWith(
			"permission_mode_toggled",
			{ mode: "approve-for-me", source: "command" },
			undefined,
		);
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
				permissionPreset: "approve-for-me" as const,
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
		await command.handler("approve-for-me", commandContext(true));
		expect(setEffectiveStepSettings).toHaveBeenCalledWith({
			permissionPreset: "approve-for-me",
			approvalMode: "auto",
			nonInteractiveApproval: "allow",
			autoResume: true,
		});
	});

	test.each(["ask", "approve-for-me"] as const)(
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
		const setStatus = vi.fn();
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
		// The default tier is Approve for Me, so the first cycle lands on Full
		// Access. A canceled dialog keeps the current tier instead of moving.
		const cancel = vi.fn(async (): Promise<string | undefined> => undefined);
		const notify = vi.fn();
		await command.handler("--cycle", {
			isIdle: () => true,
			ui: { notify, setStatus, select: cancel },
		} as unknown as ExtensionCommandContext);
		expect(cancel).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith("Full access was not enabled.", "warning");
		expect(setStatus).not.toHaveBeenCalledWith("step-permission", expect.stringContaining("Full Access"));
		expect(setEffectiveStepSettings).not.toHaveBeenCalled();

		// A granted dialog moves the tier to Full Access and still persists nothing.
		const grant = vi.fn(async () => "Yes, continue anyway — apply full access for this session");
		const grantContext = commandContext(true, grant);
		grantContext.ui.setStatus = setStatus;
		await command.handler("--cycle", grantContext);
		expect(grant).toHaveBeenCalledOnce();
		expect(setStatus).toHaveBeenCalledWith("step-permission", "Mode: Full Access (auto-resume)");
		expect(setEffectiveStepSettings).not.toHaveBeenCalled();

		// Cycling again leaves Full Access for Ask without a dialog.
		const noPrompt = vi.fn(async (): Promise<string | undefined> => undefined);
		const cycleContext = commandContext(true, noPrompt);
		cycleContext.ui.setStatus = setStatus;
		await command.handler("--cycle", cycleContext);
		expect(noPrompt).not.toHaveBeenCalled();
		expect(setStatus).toHaveBeenCalledWith("step-permission", "Mode: Ask");

		// A named preset is a deliberate choice and still persists.
		await command.handler("approve-for-me", commandContext(true));
		expect(setEffectiveStepSettings).toHaveBeenCalledWith(
			expect.objectContaining({ permissionPreset: "approve-for-me" }),
		);
	});

	test("requires the Full Access risk acknowledgment before /permissions enables it", async () => {
		const on = vi.fn();
		const registerCommand = vi.fn();
		const setEffectiveStepSettings = vi.fn();
		const select = vi.fn(async (): Promise<string | undefined> => undefined);
		createStepExtension({
			stepSettings: () => ({ getStepSettings: () => ({}), setEffectiveStepSettings }),
		})({
			registerProvider: vi.fn(),
			on,
			registerCommand,
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);

		const command = registerCommand.mock.calls.find(([name]) => name === "permissions")?.[1] as {
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		};
		const notify = vi.fn();
		const dismissed = {
			isIdle: () => true,
			ui: { notify, setStatus: vi.fn(), select },
		} as unknown as ExtensionCommandContext;

		// A dismissed dialog keeps the previous tier and persists nothing.
		await command.handler("full-access", dismissed);
		expect(select).toHaveBeenCalledWith(
			expect.stringContaining("Enable full access?"),
			expect.arrayContaining([expect.stringContaining("apply full access for this session")]),
		);
		expect(select).toHaveBeenCalledWith(
			expect.stringContaining("Enable full access?"),
			expect.arrayContaining([expect.stringContaining("remember this choice")]),
		);
		expect(setEffectiveStepSettings).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Full access was not enabled.", "warning");
		// The tier never moved: a dangerous command still asks.
		const blockedHandler = on.mock.calls.find(([name]) => name === "tool_call")?.[1] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		expect(
			await blockedHandler(
				{
					type: "tool_call",
					toolName: "run_command",
					toolCallId: "dismissed-removal",
					input: { command: "rm -rf ./build" },
				},
				{ hasUI: true, ui: { confirm: vi.fn(async () => false) } },
			),
		).toMatchObject({ block: true });

		// A session-scoped grant enables the tier and runs dangerous commands.
		select.mockImplementation(async () => "Yes, continue anyway — apply full access for this session");
		await command.handler("full-access", commandContext(true, select));
		expect(setEffectiveStepSettings).not.toHaveBeenCalled();
		const toolHandler = on.mock.calls.find(([name]) => name === "tool_call")?.[1] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		expect(
			await toolHandler(
				{
					type: "tool_call",
					toolName: "run_command",
					toolCallId: "full-access-removal",
					input: { command: "rm -rf ./build" },
				},
				{ hasUI: false },
			),
		).toBeUndefined();

		// The session-scoped grant suppresses a second prompt for the same tier.
		select.mockClear();
		await command.handler("full-access", commandContext(true, select));
		expect(select).not.toHaveBeenCalled();
	});

	test("remembers the Full Access acknowledgment when the user asks it to", async () => {
		const on = vi.fn();
		const registerCommand = vi.fn();
		const setEffectiveStepSettings = vi.fn();
		const select = vi.fn(async () => "Yes, and don't ask again — enable full access and remember this choice");
		createStepExtension({
			stepSettings: () => ({ getStepSettings: () => ({}), setEffectiveStepSettings }),
		})({
			registerProvider: vi.fn(),
			on,
			registerCommand,
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);

		const command = registerCommand.mock.calls.find(([name]) => name === "permissions")?.[1] as {
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		};
		await command.handler("full-access", commandContext(true, select));
		expect(setEffectiveStepSettings).toHaveBeenCalledWith(expect.objectContaining({ fullAccessAcknowledged: true }));
	});

	test.each([true, false])("applies the startup Full Access decision (approved=%s)", async (approved) => {
		const on = vi.fn();
		const setStatus = vi.fn();
		let answer!: (value: string | undefined) => void;
		const select = vi.fn(
			() =>
				new Promise<string | undefined>((resolve) => {
					answer = resolve;
				}),
		);
		createStepExtension({
			permission: { env: {}, initialPreset: "full-access" },
			stepSettings: () => ({ getStepSettings: () => ({}), setEffectiveStepSettings: vi.fn() }),
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
				hasUI: true,
				ui: { notify: vi.fn(), setStatus, select },
				autoRetryEnabled: false,
				setAutoRetryEnabled: vi.fn(),
			},
		);
		// The session starts on Approve for Me while the dialog is pending.
		expect(setStatus).toHaveBeenCalledWith("step-permission", "Mode: Approve for Me (auto-resume)");
		const toolHandler = on.mock.calls.find(([name]) => name === "tool_call")?.[1] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const event = {
			type: "tool_call",
			toolName: "run_command",
			toolCallId: "startup",
			input: { command: "rm -rf ./x" },
		};
		expect(await toolHandler(event, { hasUI: false })).toMatchObject({ block: true });
		answer(approved ? "Yes, continue anyway — apply full access for this session" : undefined);
		await Promise.resolve();
		await Promise.resolve();
		const confirm = vi.fn(async () => false);
		const result = await toolHandler(event, { hasUI: true, ui: { confirm } });
		if (approved) {
			expect(setStatus).toHaveBeenCalledWith("step-permission", "Mode: Full Access (auto-resume)");
			expect(result).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		} else {
			expect(setStatus).not.toHaveBeenCalledWith("step-permission", "Mode: Full Access (auto-resume)");
			expect(result).toMatchObject({ block: true });
			expect(confirm).toHaveBeenCalledOnce();
		}
	});

	test("clears the session-scoped Full Access grant on shutdown", async () => {
		const on = vi.fn();
		const registerCommand = vi.fn();
		const select = vi.fn(async () => "Yes, continue anyway — apply full access for this session");
		createStepExtension({
			stepSettings: () => ({ getStepSettings: () => ({}), setEffectiveStepSettings: vi.fn() }),
		})({
			registerProvider: vi.fn(),
			on,
			registerCommand,
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);

		const command = registerCommand.mock.calls.find(([name]) => name === "permissions")?.[1] as {
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		};
		await command.handler("full-access", commandContext(true, select));
		select.mockClear();

		const sessionShutdown = on.mock.calls.filter(([name]) => name === "session_shutdown").at(-1)?.[1] as (
			event: unknown,
			ctx: unknown,
		) => void;
		sessionShutdown({ type: "session_shutdown", reason: "quit" }, { setAutoRetryEnabled: vi.fn() });

		// The next session owes its own prompt for a session-scoped grant.
		await command.handler("full-access", commandContext(true, select));
		expect(select).toHaveBeenCalledOnce();
	});

	test.each(["session_start", "session_shutdown"] as const)(
		"ignores a stale risk-dialog answer after %s, including its remembered grant",
		async (replacement) => {
			const on = vi.fn();
			const registerCommand = vi.fn();
			const persist = vi.fn();
			createStepExtension({
				permission: { env: {}, initialPreset: "full-access" },
				stepSettings: () => ({ getStepSettings: () => ({}), setEffectiveStepSettings: persist }),
			})({ on, registerCommand, registerProvider: vi.fn(), sendUserMessage: vi.fn() } as unknown as ExtensionAPI);
			const start = on.mock.calls.filter(([name]) => name === "session_start").at(-1)![1];
			const shutdown = on.mock.calls.filter(([name]) => name === "session_shutdown").at(-1)![1];
			let answer!: (value: string) => void;
			const oldStatus = vi.fn();
			start(
				{},
				{
					hasUI: true,
					ui: {
						notify: vi.fn(),
						setStatus: oldStatus,
						select: () =>
							new Promise<string>((resolve) => {
								answer = resolve;
							}),
					},
				},
			);
			if (replacement === "session_start") {
				start({}, { hasUI: false, ui: { notify: vi.fn(), setStatus: vi.fn() } });
			} else {
				shutdown({}, {});
			}
			answer("Yes, and don't ask again — enable full access and remember this choice");
			await Promise.resolve();
			await Promise.resolve();
			expect(persist).not.toHaveBeenCalled();
			expect(oldStatus).not.toHaveBeenCalledWith("step-permission", "Mode: Full Access (auto-resume)");
			// A stale answer must not even cache the acknowledgment for a later command.
			const command = registerCommand.mock.calls.find(([name]) => name === "permissions")![1];
			const select = vi.fn(async () => undefined);
			await command.handler("full-access", commandContext(true, select));
			expect(select).toHaveBeenCalledOnce();
		},
	);

	test("remembering Full Access through the cycle persists both the tier and acknowledgment", async () => {
		const registerCommand = vi.fn();
		const persist = vi.fn();
		createStepExtension({
			permission: { env: {} },
			stepSettings: () => ({ getStepSettings: () => ({}), setEffectiveStepSettings: persist }),
		})({
			on: vi.fn(),
			registerCommand,
			registerProvider: vi.fn(),
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);
		const command = registerCommand.mock.calls.find(([name]) => name === "permissions")![1];
		await command.handler(
			"--cycle",
			commandContext(true, async () => "Yes, and don't ask again — enable full access and remember this choice"),
		);
		expect(persist).toHaveBeenCalledWith({
			permissionPreset: "full-access",
			approvalMode: "auto",
			nonInteractiveApproval: "allow",
			autoResume: true,
			fullAccessAcknowledged: true,
		});
	});

	test.each([false, true])(
		"preserves startup unattended denial when Full Access consent is granted=%s",
		async (granted) => {
			const on = vi.fn();
			createStepExtension({
				permission: { env: {}, initialPreset: "full-access", nonInteractiveApproval: "deny" },
			})({
				on,
				registerCommand: vi.fn(),
				registerProvider: vi.fn(),
				sendUserMessage: vi.fn(),
			} as unknown as ExtensionAPI);
			const start = on.mock.calls.filter(([name]) => name === "session_start").at(-1)![1];
			const status = vi.fn();
			start(
				{},
				{
					hasUI: granted,
					ui: {
						notify: vi.fn(),
						setStatus: status,
						select: async () => "Yes, continue anyway — apply full access for this session",
					},
				},
			);
			if (granted)
				await vi.waitFor(() => expect(status).toHaveBeenCalledWith("step-permission", "Mode: Full Access"));
			const tool = on.mock.calls.find(([name]) => name === "tool_call")![1];
			expect(
				await tool({ toolName: "write_file", input: { path: "file", content: "x" } }, { hasUI: false }),
			).toMatchObject({ block: true, terminate: true });
		},
	);

	test.each(["option", "environment"] as const)("keeps remembered Full Access with %s auto-resume", (source) => {
		const on = vi.fn();
		createStepExtension({
			permission: source === "option" ? { env: {}, autoResume: true } : { env: { STEP_AUTO_RESUME: "1" } },
			stepSettings: () => ({
				getStepSettings: () => ({ permissionPreset: "full-access", fullAccessAcknowledged: true }),
				setEffectiveStepSettings: vi.fn(),
			}),
		})({
			on,
			registerCommand: vi.fn(),
			registerProvider: vi.fn(),
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI);
		const start = on.mock.calls.filter(([name]) => name === "session_start").at(-1)![1];
		const status = vi.fn();
		start({}, { hasUI: false, ui: { notify: vi.fn(), setStatus: status } });
		expect(status).toHaveBeenCalledWith("step-permission", "Mode: Full Access (auto-resume)");
	});

	test("keeps explicit environment policy ahead of persisted Step settings", async () => {
		const previousPreset = process.env.STEP_PERMISSION_PRESET;
		process.env.STEP_PERMISSION_PRESET = "ask";
		try {
			const on = vi.fn();
			const settings = {
				getStepSettings: () => ({
					permissionPreset: "approve-for-me" as const,
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

	test("keeps an explicit false auto-resume value ahead of persisted auto-resume", () => {
		const on = vi.fn();
		const setStatus = vi.fn();
		createStepExtension({
			permission: { autoResume: false },
			stepSettings: () => ({
				getStepSettings: () => ({
					permissionPreset: "approve-for-me",
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
		expect(setStatus).toHaveBeenCalledWith("step-permission", "Mode: Approve for Me");
	});

	test("rehydrates project policy after the trust probe", async () => {
		const on = vi.fn();
		let persisted: "ask" | "approve-for-me" = "ask";
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
							permissionPreset: "approve-for-me" as const,
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
		persisted = "approve-for-me";
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
