import { Box, Container, Spacer, Text, visibleWidth } from "@step-harness/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionNotifyOptions } from "../../../packages/coding-agent/src/core/extensions/index.ts";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";

// Feedback: a goal set from the editor was confirmed with a dim status line, so
// the objective the user had just typed did not read as their own input.
type NotifyContext = {
	chatContainer: Container;
	redraw: { requestRender: () => void };
	lastStatusSpacer: Spacer | undefined;
	lastStatusText: Text | undefined;
	showError: (message: string) => void;
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
	showInputEcho: (message: string) => void;
};

type InteractiveModePrototype = {
	showExtensionNotify(
		this: NotifyContext,
		message: string,
		type?: "info" | "warning" | "error",
		options?: ExtensionNotifyOptions,
	): void;
	showInputEcho(this: NotifyContext, message: string): void;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createContext(): NotifyContext {
	const context: NotifyContext = {
		chatContainer: new Container(),
		redraw: { requestRender: vi.fn() },
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		showInputEcho: (message: string) => prototype.showInputEcho.call(context, message),
	};
	return context;
}

const notify = (context: NotifyContext, message: string, options?: ExtensionNotifyOptions): void =>
	prototype.showExtensionNotify.call(context, message, "info", options);

describe("InteractiveMode notification routing", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders an input echo on the user-message background", () => {
		const context = createContext();
		notify(context, "Goal set: test11", { echoesInput: true });

		const box = context.chatContainer.children.find((child) => child instanceof Box);
		expect(box).toBeInstanceOf(Box);
		const row = box?.render(40)[0] ?? "";
		// SGR 48 is a background; the depth suffix differs between a truecolor and
		// a 256-color terminal, so match the parameter rather than one encoding.
		expect(row).toMatch(/\x1b\[48;[25];/u);
		expect(row).toContain("Goal set: test11");
		// The bar spans the row, the way a user message does.
		expect(visibleWidth(row)).toBe(40);
		expect(context.showStatus).not.toHaveBeenCalled();
	});

	it("keeps an ordinary info notification on the status line", () => {
		const context = createContext();
		notify(context, "Goal cleared.");

		expect(context.showStatus).toHaveBeenCalledWith("Goal cleared.");
		expect(context.chatContainer.children).toHaveLength(0);
	});

	// A status line merges into the previous one when it is still the last child.
	// An echo must not be merged into, or a later status would overwrite it.
	it("stops the next status line from merging into the echo", () => {
		const context = createContext();
		context.lastStatusSpacer = new Spacer(1);
		context.lastStatusText = new Text("earlier", 1, 0);
		notify(context, "Goal set: test11", { echoesInput: true });

		expect(context.lastStatusSpacer).toBeUndefined();
		expect(context.lastStatusText).toBeUndefined();
	});

	it("leaves warnings and errors on their own paths", () => {
		const context = createContext();
		prototype.showExtensionNotify.call(context, "careful", "warning", { echoesInput: true });
		prototype.showExtensionNotify.call(context, "broken", "error", { echoesInput: true });

		expect(context.showWarning).toHaveBeenCalledWith("careful");
		expect(context.showError).toHaveBeenCalledWith("broken");
		expect(context.chatContainer.children).toHaveLength(0);
	});
});
