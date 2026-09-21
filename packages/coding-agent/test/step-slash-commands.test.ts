import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Component, TUI } from "@step-harness/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { createStepExtension } from "../src/features/step.ts";
import { formatStepStatus, registerStepPiCommandAdapters } from "../src/step/slash-commands.ts";
import { resolveStderrDevLogPath } from "../src/step/stderr-dev-log.ts";
import { initTheme, type Theme, theme } from "../src/theme/theme.ts";

const temporaryRoots: string[] = [];

beforeAll(() => {
	initTheme("dark");
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type RegisteredCommand = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

function registerCommands(
	options: {
		telemetry?: Parameters<typeof registerStepPiCommandAdapters>[1];
		stepSettings?: Parameters<typeof registerStepPiCommandAdapters>[2];
		feedbackIdentity?: Parameters<typeof registerStepPiCommandAdapters>[3];
	} = {},
): {
	registerCommand: ReturnType<typeof vi.fn>;
	commands: Map<string, RegisteredCommand>;
} {
	const registerCommand = vi.fn();
	const commands = new Map<string, RegisteredCommand>();
	registerCommand.mockImplementation((name: string, command: RegisteredCommand) => {
		commands.set(name, command);
	});
	registerStepPiCommandAdapters(
		{
			registerCommand,
			registerProvider: vi.fn(),
			on: vi.fn(),
			setThinkingLevel: vi.fn(),
		} as unknown as ExtensionAPI,
		options.telemetry,
		options.stepSettings,
		options.feedbackIdentity,
	);
	return { registerCommand, commands };
}

function getCommand(commands: Map<string, RegisteredCommand>, name: string): RegisteredCommand {
	const command = commands.get(name);
	if (!command) throw new Error(`command ${name} was not registered`);
	return command;
}

function createConsentCustom(
	answer: "yes" | "no" | "cancel",
	beforeInput?: () => Promise<void>,
): ReturnType<typeof vi.fn> {
	return vi.fn(
		async (
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: boolean) => void,
			) => Component | Promise<Component>,
		) => {
			const tui = {
				terminal: { rows: 24 },
				requestRender: vi.fn(),
			} as unknown as TUI;
			const keybindings = new KeybindingsManager();
			let resolveResult: (result: boolean) => void = () => {
				throw new Error("consent result resolver was not initialized");
			};
			const result = new Promise<boolean>((resolve) => {
				resolveResult = resolve;
			});
			const component = await factory(tui, theme, keybindings, resolveResult);
			component.render(80);
			await beforeInput?.();
			if (answer === "no") component.handleInput?.("\x1b[B");
			component.handleInput?.(answer === "cancel" ? "\x1b" : "\r");
			return result;
		},
	);
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

	test("does not open feedback UI when feedback is disabled", async () => {
		vi.stubEnv("STEPCODE_DISABLE_FEEDBACK", "1");
		const { commands } = registerCommands();
		const notify = vi.fn();
		const select = vi.fn();

		await getCommand(commands, "feedback").handler("", {
			hasUI: true,
			ui: { notify, select },
		} as unknown as ExtensionCommandContext);

		expect(select).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Feedback is disabled by environment settings.", "warning");
	});

	test("passes feedbackEnabled false from createStepExtension to /feedback", async () => {
		const registerCommand = vi.fn();
		const commands = new Map<string, RegisteredCommand>();
		registerCommand.mockImplementation((name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		});
		const getStepSettings = vi.fn().mockReturnValue({ feedbackEnabled: false });
		createStepExtension({
			stepSettings: () => ({
				getStepSettings,
				setEffectiveStepSettings: vi.fn(),
			}),
		})({
			registerCommand,
			registerProvider: vi.fn(),
			on: vi.fn(),
			setThinkingLevel: vi.fn(),
		} as unknown as ExtensionAPI);
		const notify = vi.fn();
		const select = vi.fn();

		await getCommand(commands, "feedback").handler("", {
			hasUI: true,
			ui: { notify, select },
		} as unknown as ExtensionCommandContext);

		expect(getStepSettings).toHaveBeenCalled();
		expect(select).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Feedback is disabled in Step settings.", "warning");
	});

	test("reports that feedback needs the interactive UI", async () => {
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		const { commands } = registerCommands();
		const notify = vi.fn();

		await getCommand(commands, "feedback").handler("", {
			hasUI: false,
			ui: { notify },
		} as unknown as ExtensionCommandContext);

		expect(notify).toHaveBeenCalledWith("/feedback requires an interactive UI.", "warning");
	});

	test("submits a shortcut comment without opening guided confirmation or attachments", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-slash-feedback-"));
		temporaryRoots.push(root);
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", root);
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		const { commands } = registerCommands();
		const confirm = vi.fn().mockResolvedValue(true);
		const notify = vi.fn();

		await getCommand(commands, "feedback").handler("the composer dropped a key", {
			hasUI: true,
			ui: { confirm, notify },
			sessionManager: { getSessionId: () => "session-1" },
		} as unknown as ExtensionCommandContext);

		expect(confirm).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledOnce();
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(body).toMatchObject({ comment: "the composer dropped a key" });
		expect(body.category).toBeUndefined();
		expect(body.diagnostics).toBeUndefined();
		const feedbackId = String(body.feedbackId);
		expect(notify).toHaveBeenCalledWith(
			`Submitted. Feedback ID: ${feedbackId} — include this ID when contacting support.`,
			"info",
		);
	});

	test("reads the current feedback identity when each shortcut is submitted", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-slash-feedback-"));
		temporaryRoots.push(root);
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", root);
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		const feedbackIdentity = vi
			.fn()
			.mockReturnValueOnce({ uid: "uid-before", username: "before@example.test" })
			.mockReturnValueOnce({ uid: "uid-current", username: "account@example.test" });
		const { commands } = registerCommands({ feedbackIdentity });

		const context = {
			hasUI: true,
			ui: { notify: vi.fn() },
			sessionManager: { getSessionId: () => "session-1" },
		} as unknown as ExtensionCommandContext;
		await getCommand(commands, "feedback").handler("before login", context);
		await getCommand(commands, "feedback").handler("after login", context);

		expect(feedbackIdentity).toHaveBeenCalledTimes(2);
		const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
			context: Record<string, unknown>;
		};
		const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
			context: Record<string, unknown>;
		};
		expect(firstBody.context).toMatchObject({ uid: "uid-before", username: "before@example.test" });
		expect(secondBody.context).toMatchObject({
			sessionId: "session-1",
			uid: "uid-current",
			username: "account@example.test",
		});
	});

	test("cancels immediately when comment input is dismissed with Esc", async () => {
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const { commands } = registerCommands();
		const select = vi.fn().mockResolvedValue("bug: Crash, error, hang, or broken behavior.");
		const input = vi.fn().mockResolvedValue(undefined);
		const confirm = vi.fn();

		await getCommand(commands, "feedback").handler("", {
			hasUI: true,
			ui: { select, input, confirm, notify: vi.fn() },
		} as unknown as ExtensionCommandContext);

		expect(select).toHaveBeenCalledOnce();
		expect(input).toHaveBeenCalledOnce();
		expect(confirm).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("renders every feedback page over the transcript", async () => {
		// An inline page grows the rendered document, which scrolls a transcript that is already
		// taller than the terminal and leaves the editor above the bottom row once the page closes.
		// The consent page is an overlay, so the rest of the flow has to be one too.
		const root = await mkdtemp(join(tmpdir(), "step-slash-feedback-"));
		temporaryRoots.push(root);
		const diagnosticsDir = join(root, "diagnostics");
		await mkdir(diagnosticsDir, { recursive: true });
		await writeFile(join(diagnosticsDir, "input-trace-1.jsonl"), '{"src":"note","text":"failed"}\n');
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", root);
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		vi.stubGlobal("fetch", vi.fn<typeof fetch>());
		const { commands } = registerCommands();
		const select = vi
			.fn()
			.mockResolvedValueOnce("bug: Crash, error, hang, or broken behavior.")
			.mockResolvedValueOnce("No · Send feedback without files");
		const input = vi.fn().mockResolvedValue("It failed");

		await getCommand(commands, "feedback").handler("", {
			mode: "rpc",
			hasUI: true,
			ui: { select, input, confirm: vi.fn().mockResolvedValue(false), notify: vi.fn() },
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => undefined,
			},
		} as unknown as ExtensionCommandContext);

		expect(select.mock.calls[0]?.[2]).toEqual({ overlay: true });
		expect(input.mock.calls[0]?.[2]).toEqual({ overlay: true });
		expect(select.mock.calls[1]?.[2]).toEqual({ overlay: true });
	});

	test("neutralizes a diagnostics filename before showing the upload selector", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-slash-feedback-"));
		temporaryRoots.push(root);
		const diagnosticsDir = join(root, "diagnostics");
		await mkdir(diagnosticsDir, { recursive: true });
		await writeFile(
			join(diagnosticsDir, "input-trace-line\nbreak-\x1b[2JOWNED.jsonl"),
			'{"src":"note","text":"failed"}\n',
		);
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", root);
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		vi.stubGlobal("fetch", vi.fn<typeof fetch>());
		const { commands } = registerCommands();
		const select = vi
			.fn()
			.mockResolvedValueOnce("bug: Crash, error, hang, or broken behavior.")
			.mockResolvedValueOnce("No · Send feedback without files");
		const confirm = vi.fn().mockResolvedValue(false);

		await getCommand(commands, "feedback").handler("", {
			mode: "rpc",
			hasUI: true,
			ui: {
				select,
				input: vi.fn().mockResolvedValue("filename control"),
				confirm,
				notify: vi.fn(),
			},
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => undefined,
			},
		} as unknown as ExtensionCommandContext);

		const uploadTitle = String(select.mock.calls[1]?.[0]);
		expect(uploadTitle).not.toContain("\x1b[2JOWNED");
		expect(uploadTitle).not.toContain("line\nbreak");
		expect(uploadTitle).toContain("line\\nbreak");
		expect(uploadTitle).toContain("\\x1b[2JOWNED.jsonl");
		expect(confirm).toHaveBeenCalledOnce();
	});

	test("previews final diagnostics and the already-built session bundle before upload", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-slash-feedback-"));
		temporaryRoots.push(root);
		const sessionFile = join(root, "20260831_session-1.jsonl");
		await writeFile(sessionFile, '{"type":"session"}\n');
		const devLogPath = resolveStderrDevLogPath(root);
		const secret = "ghp_ABCDEFGHIJKLMNOPQRST0123456789";
		await mkdir(join(root, "logs"), { recursive: true });
		await writeFile(devLogPath, `before\nError: renderer failed token=${secret}\nafter\n`);
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", root);
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		vi.stubEnv("STEPCODE_FEEDBACK_BUNDLE_ENDPOINT", "https://feedback.test/bundle");
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		const { commands } = registerCommands();
		const select = vi
			.fn()
			.mockResolvedValueOnce("bug: Crash, error, hang, or broken behavior.")
			.mockResolvedValueOnce("Yes · Include the listed files");
		const input = vi.fn().mockResolvedValue("It failed");
		const confirm = vi.fn().mockImplementation(async () => {
			await rm(sessionFile);
			return true;
		});
		const custom = vi.fn();
		const notify = vi.fn();

		await getCommand(commands, "feedback").handler("", {
			mode: "rpc",
			hasUI: true,
			ui: { select, input, confirm, custom, notify },
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => sessionFile,
			},
		} as unknown as ExtensionCommandContext);

		expect(select).toHaveBeenCalledTimes(2);
		const uploadTitle = String(select.mock.calls[1]?.[0]);
		expect(uploadTitle).toBe(`UPLOAD LOGS?\nlogs/${basename(devLogPath)}, events.jsonl, dev.log`);
		expect(select).toHaveBeenNthCalledWith(
			2,
			uploadTitle,
			["Yes · Include the listed files", "No · Send feedback without files"],
			{ overlay: true },
		);
		expect(uploadTitle).not.toContain("before");
		expect(uploadTitle).not.toContain("Error: renderer failed");
		expect(uploadTitle).not.toContain("after");
		expect(confirm).toHaveBeenCalledOnce();
		expect(custom).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://feedback.test/feedback");
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
			feedbackId: string;
			diagnostics: { lines: string[]; truncated: boolean };
		};
		const finalPreview = String(confirm.mock.calls[0]?.[1]);
		const diagnosticsContent = body.diagnostics.lines.join("\n");
		expect(confirm.mock.calls[0]?.[0]).toBe("Submit feedback?");
		expect(finalPreview).toContain(`Diagnostics: logs/${basename(devLogPath)}`);
		expect(finalPreview).toContain(
			`${Buffer.byteLength(diagnosticsContent, "utf8")} bytes, ${body.diagnostics.lines.length} lines, truncated: ${body.diagnostics.truncated ? "yes" : "no"}`,
		);
		expect(finalPreview).toContain(`--- diagnostics begin ---\n${diagnosticsContent}\n--- diagnostics end ---`);
		expect(diagnosticsContent).not.toContain(secret);
		expect(finalPreview).not.toContain(secret);
		expect(finalPreview).toContain("<redacted:");
		expect(finalPreview).toContain("events.jsonl (");
		expect(finalPreview).toContain("dev.log (");
		expect(finalPreview).toContain("context lines around 1 error");
		expect(finalPreview).toContain("session session-1, last active ");
		expect(finalPreview).toContain(
			"It contains the conversation itself: your prompts, the model's replies, tool calls and their output.",
		);
		const uploadedBundle = fetchMock.mock.calls[1]?.[1]?.body as Uint8Array;
		expect(finalPreview).toContain(`Session bundle (${uploadedBundle.byteLength} compressed bytes):`);
		const bundleUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
		expect(bundleUrl.origin + bundleUrl.pathname).toBe("https://feedback.test/bundle");
		expect(bundleUrl.searchParams.get("feedbackId")).toBe(body.feedbackId);
	});

	test("uses the archived session ID in the guided TUI report context", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-slash-feedback-"));
		temporaryRoots.push(root);
		const sessionFile = join(root, "20260831_filename-session.jsonl");
		await writeFile(sessionFile, '{"type":"session","id":"header-session"}\n');
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", root);
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		vi.stubEnv("STEPCODE_FEEDBACK_BUNDLE_ENDPOINT", "https://feedback.test/bundle");
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		const { commands } = registerCommands();
		const select = vi
			.fn()
			.mockResolvedValueOnce("bug: Crash, error, hang, or broken behavior.")
			.mockResolvedValueOnce("Yes · Include the listed files");

		await getCommand(commands, "feedback").handler("", {
			hasUI: true,
			ui: {
				select,
				input: vi.fn().mockResolvedValue("The session IDs must match"),
				confirm: vi.fn().mockResolvedValue(true),
				notify: vi.fn(),
			},
			sessionManager: {
				getSessionId: () => "manager-session",
				getSessionFile: () => sessionFile,
			},
		} as unknown as ExtensionCommandContext);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
			context: { sessionId?: string };
		};
		expect(body.context.sessionId).toBe("header-session");
	});

	test("submits guided feedback without any files when upload is declined", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-slash-feedback-"));
		temporaryRoots.push(root);
		const sessionFile = join(root, "20260831_session-1.jsonl");
		await writeFile(sessionFile, '{"type":"session"}\n');
		await mkdir(join(root, "logs"), { recursive: true });
		await writeFile(resolveStderrDevLogPath(root), "Error: renderer failed\n");
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", root);
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		vi.stubEnv("STEPCODE_FEEDBACK_BUNDLE_ENDPOINT", "https://feedback.test/bundle");
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		const { commands } = registerCommands();
		const select = vi
			.fn()
			.mockResolvedValueOnce("bug: Crash, error, hang, or broken behavior.")
			.mockResolvedValueOnce("No · Send feedback without files");
		const confirm = vi.fn().mockResolvedValue(true);

		await getCommand(commands, "feedback").handler("", {
			hasUI: true,
			ui: {
				select,
				input: vi.fn().mockResolvedValue("It failed"),
				confirm,
				notify: vi.fn(),
			},
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => sessionFile,
			},
		} as unknown as ExtensionCommandContext);

		expect(select).toHaveBeenCalledTimes(2);
		expect(confirm).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://feedback.test/feedback");
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(body.diagnostics).toBeUndefined();
	});

	test("explains when no matching session archive can be attached", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-slash-feedback-"));
		temporaryRoots.push(root);
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", root);
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		vi.stubEnv("STEPCODE_FEEDBACK_BUNDLE_ENDPOINT", "https://feedback.test/bundle");
		vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })));
		const { commands } = registerCommands();
		const select = vi.fn().mockResolvedValue("bug: Crash, error, hang, or broken behavior.");
		const notify = vi.fn();

		await getCommand(commands, "feedback").handler("", {
			hasUI: true,
			ui: {
				select,
				input: vi.fn().mockResolvedValue("No session was found"),
				confirm: vi.fn().mockResolvedValue(true),
				notify,
			},
			sessionManager: {
				getSessionId: () => "missing-session",
				getSessionFile: () => undefined,
			},
		} as unknown as ExtensionCommandContext);

		expect(select).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(
			"The session archive was not included because no matching session was found.",
			"info",
		);
		expect(notify).not.toHaveBeenCalledWith("No logs or session files are currently available.", "info");
	});

	test("does not deliver or track a submission cancelled at final confirmation", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-slash-feedback-"));
		temporaryRoots.push(root);
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", root);
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const track = vi.fn();
		const { commands } = registerCommands({ telemetry: { track } });
		const confirm = vi.fn().mockResolvedValue(false);

		await getCommand(commands, "feedback").handler("", {
			hasUI: true,
			ui: {
				select: vi.fn().mockResolvedValue("bug: Crash, error, hang, or broken behavior."),
				input: vi.fn().mockResolvedValue("do not send"),
				confirm,
				notify: vi.fn(),
			},
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => undefined,
			},
		} as unknown as ExtensionCommandContext);

		expect(confirm).toHaveBeenCalledOnce();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(track.mock.calls.some(([event]) => event === "feedback_submitted")).toBe(false);
	});

	test("uses the focused TUI consent overlay and cancels without delivery", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-slash-feedback-"));
		temporaryRoots.push(root);
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", root);
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const { commands } = registerCommands();
		const custom = createConsentCustom("cancel");
		const confirm = vi.fn();

		await getCommand(commands, "feedback").handler("", {
			mode: "tui",
			hasUI: true,
			ui: {
				select: vi.fn().mockResolvedValue("bug: Crash, error, hang, or broken behavior."),
				input: vi.fn().mockResolvedValue("do not send"),
				custom,
				confirm,
				notify: vi.fn(),
			},
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => undefined,
			},
		} as unknown as ExtensionCommandContext);

		expect(custom).toHaveBeenCalledOnce();
		expect(custom.mock.calls[0]?.[1]).toEqual({
			overlay: true,
			overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
		});
		expect(confirm).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("uploads the held bundle after the focused TUI consent accepts", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-slash-feedback-"));
		temporaryRoots.push(root);
		const sessionFile = join(root, "20260831_session-1.jsonl");
		await writeFile(sessionFile, '{"type":"session"}\n');
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", root);
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		vi.stubEnv("STEPCODE_FEEDBACK_BUNDLE_ENDPOINT", "https://feedback.test/bundle");
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		const { commands } = registerCommands();
		const select = vi
			.fn()
			.mockResolvedValueOnce("bug: Crash, error, hang, or broken behavior.")
			.mockResolvedValueOnce("Yes · Include the listed files");
		const custom = createConsentCustom("yes", async () => {
			await rm(sessionFile);
		});

		await getCommand(commands, "feedback").handler("", {
			mode: "tui",
			hasUI: true,
			ui: {
				select,
				input: vi.fn().mockResolvedValue("upload held bytes"),
				custom,
				confirm: vi.fn(),
				notify: vi.fn(),
			},
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => sessionFile,
			},
		} as unknown as ExtensionCommandContext);

		expect(custom).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { feedbackId: string };
		const bundleUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
		expect(bundleUrl.searchParams.get("feedbackId")).toBe(body.feedbackId);
		expect((fetchMock.mock.calls[1]?.[1]?.body as Uint8Array).byteLength).toBeGreaterThan(0);
	});

	test("reports body and session archive persistence when the body is rejected", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-slash-feedback-"));
		temporaryRoots.push(root);
		const sessionFile = join(root, "20260831_session-1.jsonl");
		await writeFile(sessionFile, '{"type":"session"}\n');
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", root);
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		vi.stubEnv("STEPCODE_FEEDBACK_BUNDLE_ENDPOINT", "https://feedback.test/bundle");
		vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 413 })));
		const { commands } = registerCommands();
		const select = vi
			.fn()
			.mockResolvedValueOnce("bug: Crash, error, hang, or broken behavior.")
			.mockResolvedValueOnce("Yes · Include the listed files");
		const notify = vi.fn();

		await getCommand(commands, "feedback").handler("", {
			hasUI: true,
			ui: {
				select,
				input: vi.fn().mockResolvedValue("The body was rejected"),
				confirm: vi.fn().mockResolvedValue(true),
				notify,
			},
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => sessionFile,
			},
		} as unknown as ExtensionCommandContext);

		const warning = notify.mock.calls.find(([, level]) => level === "warning");
		expect(warning).toBeDefined();
		const message = String(warning?.[0]);
		expect(message).toContain("The collector rejected the submission as too large. (HTTP 413)");
		expect(message).toContain("Session archive was not uploaded:");
		expect(message).toContain("The report it belongs to has not been accepted yet.");
		expect(message).toContain(".json");
		expect(message).toContain(".tar.gz");
	});

	test("reports a delivered body and a retryable session archive in one success notification", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-slash-feedback-"));
		temporaryRoots.push(root);
		const sessionFile = join(root, "20260831_session-1.jsonl");
		await writeFile(sessionFile, '{"type":"session"}\n');
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", root);
		vi.stubEnv("STEPCODE_FEEDBACK_ENDPOINT", "https://feedback.test/feedback");
		vi.stubEnv("STEPCODE_FEEDBACK_BUNDLE_ENDPOINT", "https://feedback.test/bundle");
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(new Response(null, { status: 409 }));
		vi.stubGlobal("fetch", fetchMock);
		const { commands } = registerCommands();
		const select = vi
			.fn()
			.mockResolvedValueOnce("bug: Crash, error, hang, or broken behavior.")
			.mockResolvedValueOnce("Yes · Include the listed files");
		const input = vi.fn().mockResolvedValue("It failed");
		const confirm = vi.fn().mockResolvedValue(true);
		const notify = vi.fn();

		await getCommand(commands, "feedback").handler("", {
			hasUI: true,
			ui: { select, input, confirm, notify },
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => sessionFile,
			},
		} as unknown as ExtensionCommandContext);

		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining(
				`Submitted. Feedback ID: ${String(body.feedbackId)} — include this ID when contacting support.`,
			),
			"info",
		);
		const message = String(notify.mock.calls[0]?.[0]);
		expect(message).toContain("The session archive was not uploaded:");
		expect(message).toContain("The collector does not have the report body required for this archive.");
		expect(message).toContain(join(root, "feedback", `pending-${String(body.feedbackId)}.tar.gz`));
		expect(message).toContain("Run `step feedback --retry` to restore the report body and send the archive again.");
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
