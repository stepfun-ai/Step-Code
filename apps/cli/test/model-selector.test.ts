import { setKeybindings, type TUI } from "@step-harness/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { stripAnsi } from "../../../packages/coding-agent/src/utils/ansi.ts";
import { createHarness, type Harness } from "../../../packages/coding-agent/test/suite/harness.ts";
import { ModelSelectorComponent } from "../src/ui/view/dialogs/model-selector.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;
	let selector: ModelSelectorComponent | undefined;

	beforeAll(() => {
		initTheme("dark");
	});
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	afterEach(() => {
		selector?.dispose();
		selector = undefined;
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

		selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector!.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});

	it("advertises Enter as select-and-save and no longer mentions Ctrl+S", async () => {
		harness = await createHarness();
		selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("Enter to select and save as default");
		expect(rendered).not.toContain("Ctrl+S");
	});

	it("shows recent models first once, with current/default badges and keyboard selection", async () => {
		harness = await createHarness({
			models: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }, { id: "gamma", name: "Gamma" }],
		});
		const [alpha, beta, gamma] = harness.models;
		const onSelect = vi.fn();
		selector = new ModelSelectorComponent(
			createFakeTui(), beta, harness.session.modelRuntime, [], onSelect, () => {},
			undefined, beta, [gamma, beta, gamma, { provider: "missing", id: "missing" }],
		);
		await vi.waitFor(() => expect(stripAnsi(selector!.render(120).join("\n"))).toContain("Model catalogs refreshed."));
		const rendered = stripAnsi(selector.render(120).join("\n"));
		const rows = rendered.split("\n").filter((line) => line.includes(`[${alpha.provider}]`));
		expect(rows.map((line) => line.trim().replace(/^→\s*/, "").split(" [")[0])).toEqual([gamma.id, beta.id, alpha.id]);
		expect(rendered).toContain("Recent");
		expect(rendered).toContain("All models");
		expect(rendered).toContain(`→ ${beta.id} [${beta.provider}] · default ✓`);
		expect(rendered).not.toContain("missing");
		selector.handleInput("\x1b[A");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: gamma.id, provider: gamma.provider }));
	});

	it("hides sections while searching, preserves default search, and restores recents when cleared", async () => {
		harness = await createHarness({
			models: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }],
		});
		const [alpha, beta] = harness.models;
		const onSelect = vi.fn();
		selector = new ModelSelectorComponent(
			createFakeTui(), alpha, harness.session.modelRuntime, [], onSelect, () => {},
			undefined, beta, [beta],
		);
		for (const char of "default") selector.handleInput(char);
		const searched = stripAnsi(selector.render(120).join("\n"));
		expect(searched).not.toContain("Recent");
		expect(searched).not.toContain("All models");
		expect(searched.split("\n").filter((line) => line.includes(`[${beta.provider}]`))).toHaveLength(1);
		expect(searched).toContain(`→ ${beta.id}`);
		for (const char of "default") selector.handleInput("\x7f");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Recent");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: beta.id }));
	});

	it("filters recent models to the active scope and restores them in All", async () => {
		harness = await createHarness({
			models: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }, { id: "gamma", name: "Gamma" }],
		});
		const [alpha, beta, gamma] = harness.models;
		selector = new ModelSelectorComponent(
			createFakeTui(), beta, harness.session.modelRuntime, [{ model: beta }, { model: alpha }],
			() => {}, () => {}, undefined, undefined, [gamma, alpha],
		);
		const scoped = stripAnsi(selector.render(120).join("\n"));
		expect(scoped).toContain("Recent");
		expect(scoped).toContain("Scoped models");
		expect(scoped).not.toContain(gamma.id);
		selector.handleInput("\t");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain(gamma.id);
		selector.handleInput("\x1b[A");
		selector.handleInput("\x1b[A");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain(`→ ${gamma.id}`);
	});

	it("does not show an empty Recent section", async () => {
		harness = await createHarness();
		selector = new ModelSelectorComponent(
			createFakeTui(), harness.getModel(), harness.session.modelRuntime, [], () => {}, () => {},
			undefined, undefined, [{ provider: "missing", id: "missing" }],
		);
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("Recent");
	});

	it("keeps identical model IDs from different providers distinct", async () => {
		harness = await createHarness({ models: [{ id: "shared", name: "Shared" }] });
		const model = harness.getModel();
		const other = { ...model, provider: "other" };
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([model, other]);
		const onSelect = vi.fn();
		selector = new ModelSelectorComponent(
			createFakeTui(), model, harness.session.modelRuntime, [], onSelect, () => {},
			undefined, undefined, [other, model],
		);
		const rows = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.filter((line) => line.includes(`${model.id} [`));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("[other]");
		selector.handleInput("\x1b[A");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(other);
	});

	it("scrolls across the Recent boundary without selecting headings", async () => {
		harness = await createHarness({
			models: Array.from({ length: 15 }, (_, i) => ({ id: `model-${i}`, name: `Model ${i}` })),
		});
		const onSelect = vi.fn();
		selector = new ModelSelectorComponent(
			createFakeTui(), harness.models[0], harness.session.modelRuntime, [], onSelect, () => {},
			undefined, undefined, harness.models.slice(0, 10),
		);
		for (let i = 0; i < 10; i++) selector.handleInput("\x1b[B");
		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("Recent");
		expect(rendered).toContain("All models");
		expect(rendered).toContain("(11/15)");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "model-10" }));
	});
});
