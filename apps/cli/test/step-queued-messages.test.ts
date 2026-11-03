import { setKeybindings, stripTerminalSequences, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { StepQueuedMessagesComponent } from "../src/ui/view/transcript/step-queued-messages.ts";
import { initTheme, theme } from "../../../packages/coding-agent/src/theme/theme.ts";

beforeEach(() => {
	initTheme("step-blue");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("StepQueuedMessagesComponent", () => {
	test("renders queued messages without the legacy queue chrome", () => {
		initTheme("step-blue");
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
	test("wraps a long queued message without dropping characters", () => {
		const message = "顺便帮我把登录流程里那个多余的 token 刷新逻辑去掉，然后跑一下相关的单元测试确认没有回归";
		const component = new StepQueuedMessagesComponent();
		component.setMessages({ steering: [message], followUp: [] });

		const lines = component.render(60).map(stripTerminalSequences);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);

		// The message fits the two-row preview budget, so the rendered rows must
		// reproduce it exactly; the old hand-rolled wrap ate four characters here.
		const hintIndex = lines.findIndex((line) => line.includes("edit all queued messages"));
		const squash = (value: string) => value.replace(/\s+/gu, "");
		expect(squash(lines.slice(0, hintIndex).join(""))).toBe(`1.${squash(message)}`);
	});

	test("keeps the truncated preview a prefix of the original message", () => {
		// Distinct characters on a 10-glyph cycle: a dropped run shifts the phase,
		// so the prefix assertion below actually detects loss.
		const message = "甲乙丙丁戊己庚辛壬癸".repeat(12);
		const component = new StepQueuedMessagesComponent();
		component.setMessages({ steering: [message], followUp: [] });

		const lines = component.render(40).map(stripTerminalSequences);
		const hintIndex = lines.findIndex((line) => line.includes("edit all queued messages"));
		const shown = lines.slice(0, hintIndex).join("").replace(/\s+/gu, "");

		expect(shown.endsWith("…")).toBe(true);
		expect(`1.${message}`.startsWith(shown.slice(0, -1))).toBe(true);
	});
});
