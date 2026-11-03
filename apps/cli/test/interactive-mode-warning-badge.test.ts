import { Container } from "@step-harness/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PromptOptions } from "../../../packages/coding-agent/src/core/agent-session.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { stripAnsi } from "../../../packages/coding-agent/src/utils/ansi.ts";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";
import {
	type SessionWarning,
	WarningListComponent,
	warningListCapacity,
} from "../src/ui/view/dialogs/warning-list.ts";

type SessionWarningRecord = SessionWarning & { sessionId: string };

type WarningHost = {
	presentation: "native" | "step";
	chatContainer: Container;
	warningLog: SessionWarningRecord[];
	acceptingUserInput: number;
	redraw: { requestRender: ReturnType<typeof vi.fn> };
	sessionManager: { getSessionId: () => string };
	session: { prompt: ReturnType<typeof vi.fn> };
	showWarning(message: string): void;
	recordWarning(message: string): void;
	showStatus: ReturnType<typeof vi.fn>;
};

function method<T>(name: string): T {
	return Reflect.get(InteractiveMode.prototype, name) as T;
}

const showWarning = method<(this: WarningHost, message: string) => void>("showWarning");
const recordWarning = method<(this: WarningHost, message: string) => void>("recordWarning");
const showExtensionNotify = method<(this: WarningHost, message: string, type?: "info" | "warning" | "error") => void>(
	"showExtensionNotify",
);
const promptUserInput = method<(this: WarningHost, text: string) => Promise<void>>("promptUserInput");
const warningsForCurrentSession = method<(this: WarningHost) => SessionWarning[]>("warningsForCurrentSession");

function createHost(overrides: Partial<WarningHost> = {}): WarningHost {
	const host: WarningHost = {
		presentation: "step",
		chatContainer: new Container(),
		warningLog: [],
		acceptingUserInput: 0,
		redraw: { requestRender: vi.fn() },
		sessionManager: { getSessionId: () => "session-1" },
		session: { prompt: vi.fn(async () => {}) },
		showWarning,
		recordWarning,
		showStatus: vi.fn(),
		...overrides,
	};
	return host;
}

describe("Step warning routing", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("counts an ambient warning in the badge instead of writing a transcript row", () => {
		const host = createHost();

		host.recordWarning("Invalid settings file /tmp/settings.json");

		expect(host.chatContainer.children).toHaveLength(0);
		expect(host.warningLog).toEqual([
			{ message: "Invalid settings file /tmp/settings.json", at: expect.any(Number), sessionId: "session-1" },
		]);
	});

	it("keeps ambient warnings in the transcript for the Pi presentation", () => {
		const host = createHost({ presentation: "native" });

		host.recordWarning("Invalid settings file /tmp/settings.json");

		expect(host.warningLog).toHaveLength(0);
		expect(stripAnsi(host.chatContainer.render(120).join("\n"))).toContain("Warning: Invalid settings file");
	});

	it("answers the user's action inline", () => {
		const host = createHost();

		host.showWarning("Usage: /name <name>");

		expect(host.warningLog).toHaveLength(0);
		expect(stripAnsi(host.chatContainer.render(120).join("\n"))).toContain("Warning: Usage: /name <name>");
	});

	it("shows a command's notify warning inline and a background one in the badge", async () => {
		const host = createHost();
		host.session.prompt.mockImplementation(async () => {
			showExtensionNotify.call(host, "Usage: /cron delete <id>", "warning");
		});

		await promptUserInput.call(host, "/cron delete");
		showExtensionNotify.call(host, "Lark connection failed during handshake.", "warning");

		expect(stripAnsi(host.chatContainer.render(120).join("\n"))).toContain("Usage: /cron delete <id>");
		expect(host.warningLog.map((entry) => entry.message)).toEqual(["Lark connection failed during handshake."]);
		expect(host.acceptingUserInput).toBe(0);
	});

	it("keeps an input hook's warning inline and sends the turn's warnings to the badge", async () => {
		const host = createHost();
		host.session.prompt.mockImplementation(async (_text: string, options?: PromptOptions) => {
			// The paused-goal reminder runs in the input hook, before the kernel accepts the message.
			showExtensionNotify.call(host, "Goal g1 is paused; run /goal resume to continue it.", "warning");
			options?.preflightResult?.(true);
			showExtensionNotify.call(host, "Context is almost full.", "warning");
		});

		await promptUserInput.call(host, "refactor the parser");

		expect(stripAnsi(host.chatContainer.render(120).join("\n"))).toContain("Goal g1 is paused");
		expect(host.warningLog.map((entry) => entry.message)).toEqual(["Context is almost full."]);
	});

	it("passes acceptance on to a caller that observes it", async () => {
		const host = createHost();
		const observed = vi.fn();
		host.session.prompt.mockImplementation(async (_text: string, options?: PromptOptions) => {
			options?.preflightResult?.(true);
		});

		await (promptUserInput as (this: WarningHost, text: string, options?: PromptOptions) => Promise<void>).call(
			host,
			"/goal status",
			{ preflightResult: observed },
		);

		expect(observed).toHaveBeenCalledWith(true);
		expect(host.acceptingUserInput).toBe(0);
	});

	it("closes the reply window when the prompt fails", async () => {
		const host = createHost();
		host.session.prompt.mockRejectedValue(new Error("boom"));

		await expect(promptUserInput.call(host, "/goal start")).rejects.toThrow("boom");
		expect(host.acceptingUserInput).toBe(0);
	});

	it("counts only the warnings recorded for the current session", () => {
		let sessionId = "session-1";
		const host = createHost({ sessionManager: { getSessionId: () => sessionId } });
		host.recordWarning("first");
		sessionId = "session-2";
		host.recordWarning("second");

		expect(warningsForCurrentSession.call(host).map((warning) => warning.message)).toEqual(["second"]);
		sessionId = "session-1";
		expect(warningsForCurrentSession.call(host).map((warning) => warning.message)).toEqual(["first"]);
	});
});

describe("WarningListComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createList(warnings: SessionWarning[], maxVisible = 6) {
		const onClose = vi.fn();
		const onClear = vi.fn();
		const list = new WarningListComponent({ getWarnings: () => warnings, maxVisible, onClose, onClear });
		return { list, onClose, onClear, warnings };
	}

	it("lists the newest warning first and reports a clear request", () => {
		const { list, onClose, onClear } = createList([
			{ message: "older warning", at: 1 },
			{ message: "newer warning", at: 2 },
		]);

		const rendered = stripAnsi(list.render(80).join("\n"));
		expect(rendered).toContain("Warnings (2)");
		expect(rendered.indexOf("newer warning")).toBeLessThan(rendered.indexOf("older warning"));

		list.handleInput("c");
		expect(onClear).toHaveBeenCalledOnce();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("shows a warning that arrives while the list is open", () => {
		const { list, warnings } = createList([{ message: "first", at: 1 }]);
		expect(stripAnsi(list.render(80).join("\n"))).toContain("Warnings (1)");

		warnings.push({ message: "arrived later", at: 2 });

		const rendered = stripAnsi(list.render(80).join("\n"));
		expect(rendered).toContain("Warnings (2)");
		expect(rendered).toContain("arrived later");
	});

	it("shows only as many warnings as fit and says where the window is", () => {
		const warnings = Array.from({ length: 5 }, (_, index) => ({ message: `warning ${index}`, at: index }));
		const { list } = createList(warnings, 2);

		const rendered = stripAnsi(list.render(80).join("\n"));
		expect(rendered).toContain("warning 4");
		expect(rendered).toContain("warning 3");
		expect(rendered).not.toContain("warning 2");
		expect(rendered).toContain("1-2 of 5");
	});

	it("sizes the list to the terminal height", () => {
		expect(warningListCapacity(12)).toBe(1);
		expect(warningListCapacity(19)).toBe(3);
		expect(warningListCapacity(80)).toBe(6);
	});
});
