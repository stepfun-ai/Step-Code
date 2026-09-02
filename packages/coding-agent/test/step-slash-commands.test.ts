import { describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { formatStepStatus, registerStepPiCommandAdapters } from "../src/step/slash-commands.ts";

type RegisteredCommand = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

function registerCommands(): {
	registerCommand: ReturnType<typeof vi.fn>;
	commands: Map<string, RegisteredCommand>;
} {
	const registerCommand = vi.fn();
	const commands = new Map<string, RegisteredCommand>();
	registerCommand.mockImplementation((name: string, command: RegisteredCommand) => {
		commands.set(name, command);
	});
	registerStepPiCommandAdapters({
		registerCommand,
		registerProvider: vi.fn(),
		on: vi.fn(),
		setThinkingLevel: vi.fn(),
	} as unknown as ExtensionAPI);
	return { registerCommand, commands };
}

function getCommand(commands: Map<string, RegisteredCommand>, name: string): RegisteredCommand {
	const command = commands.get(name);
	if (!command) throw new Error(`command ${name} was not registered`);
	return command;
}

describe("Step Pi slash command adapters", () => {
	test("does not expose the removed changelog command", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "changelog")).toBe(false);
	});

	test("exposes /effort as a built-in /thinking alias", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "effort")).toMatchObject({
			name: "effort",
			argumentHint: "<level>",
		});
	});

	test("registers product adapters without replacing Pi's native commands", () => {
		const { commands } = registerCommands();

		expect([...commands.keys()]).toEqual(expect.arrayContaining(["plugin", "clear", "exit", "theme", "status"]));
		expect(commands.has("effort")).toBe(false);
	});

	test("routes /clear to Pi's session replacement action", async () => {
		const { commands } = registerCommands();
		const newSession = vi.fn().mockResolvedValue({ cancelled: false });

		await getCommand(commands, "clear").handler("", {
			newSession,
		} as unknown as ExtensionCommandContext);

		expect(newSession).toHaveBeenCalledOnce();
		expect(newSession).toHaveBeenCalledWith();
	});

	test("reports a recognized adapter command without recording its arguments", async () => {
		const registerCommand = vi.fn();
		const commands = new Map<string, RegisteredCommand>();
		registerCommand.mockImplementation((name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		});
		const track = vi.fn();
		registerStepPiCommandAdapters(
			{
				registerCommand,
				registerProvider: vi.fn(),
				on: vi.fn(),
				setThinkingLevel: vi.fn(),
			} as unknown as ExtensionAPI,
			{ track },
		);

		await getCommand(commands, "exit").handler("secret argument", {
			shutdown: vi.fn(),
		} as never);

		expect(track).toHaveBeenCalledWith(
			"slash_command_used",
			{
				command: "/exit",
				recognized: true,
			},
			undefined,
		);
	});

	test("routes /exit to Pi's graceful shutdown action", async () => {
		const { commands } = registerCommands();
		const shutdown = vi.fn();

		await getCommand(commands, "exit").handler("ignored arguments", {
			shutdown,
		} as unknown as ExtensionCommandContext);

		expect(shutdown).toHaveBeenCalledOnce();
	});

	test("uses Pi's UI selector and theme setter for /theme", async () => {
		const { commands } = registerCommands();
		const select = vi.fn().mockResolvedValue("light");
		const setTheme = vi.fn().mockReturnValue({ success: true });
		const notify = vi.fn();
		const ui = {
			select,
			setTheme,
			notify,
			getAllThemes: vi.fn().mockReturnValue([
				{ name: "dark", path: undefined },
				{ name: "light", path: undefined },
			]),
		};

		await getCommand(commands, "theme").handler("", {
			hasUI: true,
			ui,
		} as unknown as ExtensionCommandContext);

		expect(select).toHaveBeenCalledWith("Theme", ["dark", "light"]);
		expect(setTheme).toHaveBeenCalledWith("light");
		expect(notify).toHaveBeenCalledWith("Theme: light", "info");
	});

	test("accepts a direct /theme argument and reports Pi's error", async () => {
		const { commands } = registerCommands();
		const setTheme = vi.fn().mockReturnValue({ success: false, error: "theme not found" });
		const select = vi.fn();
		const notify = vi.fn();

		await getCommand(commands, "theme").handler("missing", {
			hasUI: true,
			ui: { select, setTheme, notify, getAllThemes: vi.fn() },
		} as unknown as ExtensionCommandContext);

		expect(select).not.toHaveBeenCalled();
		expect(setTheme).toHaveBeenCalledWith("missing");
		expect(notify).toHaveBeenCalledWith("Failed to set theme: theme not found", "warning");
	});

	test("does not attempt theme selection without an interactive UI", async () => {
		const { commands } = registerCommands();
		const notify = vi.fn();

		await getCommand(commands, "theme").handler("", {
			hasUI: false,
			ui: { notify },
		} as unknown as ExtensionCommandContext);

		expect(notify).toHaveBeenCalledWith("/theme requires an interactive UI.", "warning");
	});

	test("formats status from public Pi context without exposing credentials", () => {
		const ctx = {
			cwd: "/workspace",
			model: { provider: "step", id: "step-3.7-flash", reasoning: true },
			thinkingLevel: "medium",
			isIdle: () => true,
			sessionManager: { getSessionId: () => "session-1" },
			getContextUsage: () => ({
				tokens: 120,
				contextWindow: 1000,
				percent: 12,
			}),
		} as unknown as ExtensionCommandContext;

		expect(formatStepStatus(ctx)).toBe(
			"Session: session-1\nWorkspace: /workspace\nState: idle\nModel: step/step-3.7-flash\nThinking: medium\nContext: 120/1,000 tokens (12.0%)",
		);
	});
});
