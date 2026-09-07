import { setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { StepQueuedMessagesComponent } from "../src/modes/interactive/components/step-queued-messages.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

beforeEach(() => {
	initTheme("step");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("StepQueuedMessagesComponent", () => {
	test("renders queued messages without the legacy queue chrome", () => {
		initTheme("step");
		const component = new StepQueuedMessagesComponent();
		component.setMessages({ steering: ["first"], followUp: ["second"] });
		const lines = component.render(60).map(stripTerminalSequences);

		expect(lines[0]).toBe("1. first");
		expect(lines).toContain("1. first");
		expect(lines).toContain("2. second");
		expect(lines).toContain("↑ edit all queued messages");
		expect(lines.at(-1)).toBe("─".repeat(60));
		expect(lines).not.toContain("queue");
		const rawHint = component.render(60).find((line) => stripTerminalSequences(line).includes("↑"));
		expect(rawHint).toContain(`${theme.getFgAnsi("accent")}↑`);
	});

	test("updates the hint when the configured dequeue binding changes", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const component = new StepQueuedMessagesComponent();
		component.setMessages({ steering: ["first"], followUp: [] });

		keybindings.setUserBindings({ "app.message.dequeue": "ctrl+r" });
		expect(component.render(60).map(stripTerminalSequences)).toContain("ctrl+r edit all queued messages");

		keybindings.setUserBindings({ "app.message.dequeue": [] });
		expect(component.render(60).map(stripTerminalSequences).join("\n")).not.toContain("edit all queued messages");
	});

	test("hides the queue and hint once all messages have been restored", () => {
		const component = new StepQueuedMessagesComponent();
		component.setMessages({ steering: ["first"], followUp: [] });
		component.setMessages({ steering: [], followUp: [] });
		expect(component.render(60)).toEqual([]);
	});

	test("limits previews and clamps CJK rows to the terminal width", () => {
		const component = new StepQueuedMessagesComponent();
		component.setMessages({
			steering: ["一".repeat(80), "two", "three", "four"],
			followUp: [],
		});
		for (const line of component.render(24)) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		const text = component.render(24).map(stripTerminalSequences).join("\n");
		expect(text).toContain("+1 more");
		expect(text).toContain("…");
	});
});
