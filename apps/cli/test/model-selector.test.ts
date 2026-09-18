import type { TUI } from "@step-harness/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelSelectorComponent } from "../src/ui/view/dialogs/model-selector.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { stripAnsi } from "../../../packages/coding-agent/src/utils/ansi.ts";
import { createHarness, type Harness } from "../../../packages/coding-agent/test/suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});
});
