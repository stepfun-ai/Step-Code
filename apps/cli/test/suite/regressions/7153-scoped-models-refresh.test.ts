import type { Api, Model, ModelsRefreshResult } from "@step-harness/providers";
import { setKeybindings, type TUI } from "@step-harness/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../../../packages/coding-agent/src/core/keybindings.ts";
import type { ScopedModelsSelectorComponent } from "../../../src/ui/view/dialogs/scoped-models-selector.ts";
import { InteractiveMode } from "../../../src/ui/interactive-mode.ts";
import { initTheme } from "../../../../../packages/coding-agent/src/theme/theme.ts";
import { stripAnsi } from "../../../../../packages/coding-agent/src/utils/ansi.ts";
import { createHarness, type Harness } from "../../../../../packages/coding-agent/test/suite/harness.ts";

const showModelsSelector = Reflect.get(InteractiveMode.prototype, "showModelsSelector") as (this: object) => void;

function openSelector(harness: Harness, initialModels: readonly Model<Api>[]) {
	let snapshot = initialModels;
	let finishRefresh: ((result: ModelsRefreshResult) => void) | undefined;
	let refreshSignal: AbortSignal | undefined;
	let selector: ScopedModelsSelectorComponent | undefined;
	let dispose: (() => void) | undefined;
	const done = vi.fn();
	vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockImplementation(() => snapshot);
	vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(
		(options) =>
			new Promise((resolve) => {
				refreshSignal = options?.signal;
				finishRefresh = resolve;
			}),
	);
	const context = {
		session: harness.session,
		settingsManager: harness.settingsManager,
		showSelector: (
			factory: (close: () => void) => {
				component: ScopedModelsSelectorComponent;
				dispose?: () => void;
			},
		) => {
			const close = () => {
				dispose?.();
				done();
			};
			const created = factory(close);
			selector = created.component;
			dispose = created.dispose;
		},
		updateAvailableProviderCount: vi.fn(),
		ui: { requestRender: vi.fn() } as unknown as TUI,
		redraw: { requestRender: vi.fn(), forceRender: vi.fn(), renderNow: vi.fn() },
	};

	showModelsSelector.call(context);
	if (!selector) throw new Error("Expected scoped-model selector to open");
	return {
		done,
		get refreshSignal() {
			return refreshSignal;
		},
		selector,
		complete(models: readonly Model<Api>[], result: ModelsRefreshResult) {
			snapshot = models;
			if (!finishRefresh) throw new Error("Expected model refresh to start");
			finishRefresh(result);
		},
	};
}

describe("issue #7153 scoped models refresh", () => {
	let harness: Harness | undefined;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("renders cached models immediately and updates after background refresh", async () => {
		harness = await createHarness({
			models: [
				{ id: "cached", name: "Cached" },
				{ id: "refreshed", name: "Refreshed" },
			],
		});
		const refresh = openSelector(harness, [harness.models[0]]);

		const initial = stripAnsi(refresh.selector.render(100).join("\n"));
		expect(initial).toContain("cached");
		expect(initial).toContain("Refreshing model catalogs…");
		expect(initial).not.toContain("refreshed");

		refresh.complete(harness.models, { aborted: false, errors: new Map() });
		await vi.waitFor(() => {
			const rendered = stripAnsi(refresh.selector.render(100).join("\n"));
			expect(rendered).toContain("refreshed");
			expect(rendered).toContain("Model catalogs refreshed.");
		});
	});

	it("cancels the background refresh when the selector closes", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const refresh = openSelector(harness, harness.models);

		expect(refresh.refreshSignal).toBeDefined();
		refresh.selector.handleInput("\x1b");
		await vi.waitFor(() => expect(refresh.refreshSignal?.aborted).toBe(true));
		expect(refresh.done).toHaveBeenCalledOnce();
	});
});
