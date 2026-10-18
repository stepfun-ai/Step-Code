import { fauxAssistantMessage, fauxProvider } from "@step-harness/providers";
import { expect, test, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import sessionTitleExtension from "../../src/features/session-title.ts";
import { createHarness } from "./harness.ts";

test("Pi lifecycle persists the title and emits the existing UI event without changing the transcript", async () => {
	let api: ExtensionAPI | undefined;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				api = pi;
				sessionTitleExtension(pi);
			},
		],
	});
	try {
		const titleProvider = fauxProvider({ api: harness.faux.api, provider: harness.models[0].provider });
		titleProvider.setResponses([fauxAssistantMessage("Login timeout fix")]);
		api?.registerProvider(titleProvider.provider);
		await harness.session.setModel(titleProvider.getModel());
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([fauxAssistantMessage("Working on login")]);
		await harness.session.prompt("Fix login timeout");
		await vi.waitFor(() => expect(harness.session.sessionName).toBe("Login timeout fix"));
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual([
			"Fix login timeout",
			"Login timeout fix",
		]);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(harness.session.messages[1]).toMatchObject({ content: [{ type: "text", text: "Working on login" }] });
	} finally {
		harness.cleanup();
	}
});
