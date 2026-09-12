import { type Component, Markdown, stripTerminalSequences } from "@step-harness/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";

describe("interactive hotkey help", () => {
	it("omits the follow-up row when the action has no keybinding", () => {
		initTheme("dark");
		const children: Component[] = [];
		const fakeThis = {
			getEditorKeyDisplay: () => "Key",
			getAppKeyDisplay: (action: string) => (action === "app.message.followUp" ? "" : "Key"),
			session: { extensionRunner: { getShortcuts: () => new Map() } },
			keybindings: { getEffectiveConfig: () => ({}) },
			chatContainer: { addChild: (component: Component) => children.push(component) },
			ui: { requestRender: vi.fn() },
			redraw: { requestRender: vi.fn(), forceRender: vi.fn(), renderNow: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		};
		const handleHotkeysCommand = Reflect.get(InteractiveMode.prototype, "handleHotkeysCommand") as (
			this: typeof fakeThis,
		) => void;

		handleHotkeysCommand.call(fakeThis);

		const markdown = children.find((child): child is Markdown => child instanceof Markdown);
		if (!markdown) throw new Error("Expected hotkey Markdown output");
		const output = stripTerminalSequences(markdown.render(200).join("\n"));
		expect(output).not.toContain("Queue follow-up message");
	});
});
