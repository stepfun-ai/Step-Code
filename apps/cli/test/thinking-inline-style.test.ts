import type { AssistantMessage } from "@step-harness/providers";
import { resetCapabilitiesCache, setCapabilities } from "@step-harness/pi-tui";
import { afterEach, expect, test } from "vitest";
import { initTheme, theme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { AssistantMessageComponent } from "../src/ui/view/transcript/assistant-message.ts";

afterEach(() => {
	resetCapabilitiesCache();
	initTheme("dark");
});

test.each(["step-blue", "step-violet", "step-violet-light"])("thinking code is muted while body code retains its theme in %s", (name) => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	initTheme(name);
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Inspect `thinking.ts` first." },
			{ type: "text", text: "Updated `body.ts`." },
		],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	};
	const component = new AssistantMessageComponent(message);
	const lines = component.render(80);
	const thinking = lines.find((line) => line.includes("thinking.ts"));
	const body = lines.find((line) => line.includes("body.ts"));
	expect(thinking).toContain(theme.fg("muted", "thinking.ts"));
	expect(thinking).not.toContain(theme.getFgAnsi("mdCode"));
	expect(body).toContain(theme.fg("mdCode", "body.ts"));
});
