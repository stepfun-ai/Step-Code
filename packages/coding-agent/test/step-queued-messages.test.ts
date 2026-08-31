import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { StepQueuedMessagesComponent } from "../src/modes/interactive/components/step-queued-messages.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("StepQueuedMessagesComponent", () => {
	test("renders queued messages without the legacy queue chrome", () => {
		initTheme("step");
		const component = new StepQueuedMessagesComponent();
		component.setMessages({ steering: ["first"], followUp: ["second"] });
		const lines = component.render(60).map(stripTerminalSequences);

		expect(lines[0]).toBe("1. first");
		expect(lines).toContain("1. first");
		expect(lines).toContain("2. second");
		expect(lines).toContain("alt+↑ edit last queued message");
		expect(lines.at(-1)).toBe("─".repeat(60));
		expect(lines).not.toContain("queue");
		const rawHint = component.render(60).find((line) => stripTerminalSequences(line).includes("alt+↑"));
		expect(rawHint).toContain(`${theme.getFgAnsi("accent")}alt+↑`);
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
