import { setKeybindings, stripTerminalSequences, type TUI, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { BranchSummaryMessageComponent } from "../src/ui/view/transcript/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/ui/view/transcript/compaction-summary-message.ts";
import { ExtensionEditorComponent } from "../src/ui/view/dialogs/extension-editor.ts";
import { ExtensionInputComponent } from "../src/ui/view/dialogs/extension-input.ts";
import { ExtensionSelectorComponent } from "../src/ui/view/dialogs/extension-selector.ts";
import { LoginDialogComponent } from "../src/ui/view/dialogs/login-dialog.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	WorkingStatusIndicator,
} from "../src/ui/view/chrome/status-indicator.ts";
import { StepSelectorFrame } from "../src/ui/view/dialogs/step-dialog.ts";
import { TrustSelectorComponent } from "../src/ui/view/dialogs/trust-selector.ts";
import { getMarkdownTheme, initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";

const fakeTui = {
	requestRender: () => {},
	terminal: { rows: 24 },
} as unknown as TUI;

afterEach(() => {
	initTheme("dark");
});

describe("Step transient presentation", () => {
	it("frames selectors while native SelectList owns movement and confirmation", () => {
		initTheme("step-blue");
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const selected: string[] = [];
		const selector = new ExtensionSelectorComponent(
			"Approve tool call\nrun_command rm -rf ./build?",
			["Yes", "No"],
			(value) => selected.push(value),
			() => undefined,
			{ presentation: "step" },
		);

		const rows = selector.render(60);
		expect(stripTerminalSequences(rows[0] ?? "")).toMatch(/^╭/u);
		expect(stripTerminalSequences(rows.at(-1) ?? "")).toMatch(/╯$/u);
		expect(rows.some((row) => stripTerminalSequences(row).includes("Approve tool call"))).toBe(true);
		for (const row of rows) expect(visibleWidth(row)).toBe(60);

		selector.handleInput("\u001b[B");
		selector.handleInput("\r");
		expect(selected).toEqual(["No"]);
		// Step keeps the decision list non-circular at its lower boundary.
		selector.handleInput("\u001b[B");
		selector.handleInput("\r");
		expect(selected).toEqual(["No", "No"]);
	});

	it("can frame an unstyled Pi selector without taking its focus or input", () => {
		initTheme("step-blue");
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const selected: boolean[] = [];
		const selector = new TrustSelectorComponent({
			cwd: "/project",
			savedDecision: null,
			projectTrusted: false,
			onSelect: ({ trusted }) => selected.push(trusted),
			onCancel: () => undefined,
		});
		const frame = new StepSelectorFrame(selector);
		const rows = frame.render(60);

		expect(stripTerminalSequences(rows[0] ?? "")).toMatch(/^╭/u);
		expect(stripTerminalSequences(rows.at(-1) ?? "")).toMatch(/╯$/u);
		for (const row of rows) expect(visibleWidth(row)).toBe(60);

		// The wrapper has no handleInput method; the original focused selector
		// still receives native key dispatch and invokes the business callback.
		selector.handleInput("\r");
		expect(selected).toEqual([true]);
	});

	it("renders the wrapped selector once per frame", () => {
		initTheme("step-blue");
		let renderCount = 0;
		const child = {
			invalidate: () => undefined,
			render: (width: number) => {
				renderCount += 1;
				return ["─".repeat(width), "option", "─".repeat(width)];
			},
		};
		const frame = new StepSelectorFrame(child);

		const rows = frame.render(48);
		expect(renderCount).toBe(1);
		expect(rows.join("\n")).toContain("option");
	});

	it("keeps input/IME handling native inside the Step frame", () => {
		initTheme("step-blue");
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		let submitted = "";
		const input = new ExtensionInputComponent(
			"Workspace name",
			"e.g. demo",
			(value) => {
				submitted = value;
			},
			() => undefined,
			{ presentation: "step" },
		);
		input.handleInput("你");
		input.handleInput("好");
		input.handleInput("\r");
		expect(submitted).toBe("你好");
		const rows = input.render(48);
		expect(stripTerminalSequences(rows[0] ?? "")).toMatch(/^╭/u);
		expect(rows.join("\n")).toContain("你好");
		for (const row of rows) expect(visibleWidth(row)).toBe(48);
	});

	it("filters a searchable selector by typing and keeps the list in charge of Enter", () => {
		initTheme("step-blue");
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const selected: string[] = [];
		const selector = new ExtensionSelectorComponent(
			"All Plugins (3 available)",
			["skill-creator · official", "code-review · official", "plan-to-lark · plan-to-lark"],
			(value) => selected.push(value),
			() => undefined,
			{ presentation: "step", searchable: true },
		);

		const plain = (): string => selector.render(80).map(stripTerminalSequences).join("\n");
		expect(plain()).toContain("Search:");

		// Typing goes to the query, not to the list.
		for (const char of "rev") selector.handleInput(char);
		const filtered = plain();
		expect(filtered).toContain("code-review");
		expect(filtered).not.toContain("plan-to-lark");

		// Enter still confirms the highlighted match.
		selector.handleInput("\r");
		expect(selected).toEqual(["code-review · official"]);

		// A query that matches nothing shows the empty state instead of the
		// options it excluded.
		const empty = new ExtensionSelectorComponent(
			"All Plugins",
			["alpha", "beta"],
			() => undefined,
			() => undefined,
			{ presentation: "step", searchable: true },
		);
		for (const char of "zzz") empty.handleInput(char);
		const emptyRows = empty.render(80).map(stripTerminalSequences).join("\n");
		expect(emptyRows).toContain("No matching");
		expect(emptyRows).not.toContain("alpha");
	});

	it("lists examples above the input row", () => {
		initTheme("step-blue");
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const input = new ExtensionInputComponent(
			"Add Marketplace",
			undefined,
			() => undefined,
			() => undefined,
			{
				presentation: "step",
				examples: ["owner/repo (GitHub)", "./path/to/marketplace"],
			},
		);

		const before = input.render(60);
		const plainBefore = before.map(stripTerminalSequences);
		const examplesRow = plainBefore.findIndex((row) => row.includes("Examples:"));
		const firstExampleRow = plainBefore.findIndex((row) => row.includes("owner/repo (GitHub)"));
		expect(examplesRow).toBeGreaterThan(0);
		expect(firstExampleRow).toBe(examplesRow + 1);
		// The examples sit above the editable row, not below it.
		const inputRow = plainBefore.findIndex((row) => row.includes("> "));
		expect(inputRow).toBeGreaterThan(firstExampleRow);
		for (const row of before) expect(visibleWidth(row)).toBe(60);

		// The reference lines stay put while the value is edited.
		input.handleInput("g");
		const after = input.render(60).map(stripTerminalSequences);
		expect(after.some((row) => row.includes("Examples:"))).toBe(true);
		expect(after.some((row) => row.includes("owner/repo (GitHub)"))).toBe(true);
	});

	it("frames the extension editor while retaining native editing", () => {
		initTheme("step-blue");
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		let submitted = "";
		const editor = new ExtensionEditorComponent(
			fakeTui,
			keybindings,
			"Summarize branch",
			undefined,
			(value) => {
				submitted = value;
			},
			() => undefined,
			undefined,
			undefined,
			"step",
		);
		editor.handleInput("你");
		editor.handleInput("好");
		const beforeSubmit = editor.render(56);
		expect(beforeSubmit.join("\n")).toContain("你好");
		editor.handleInput("\r");
		expect(submitted).toBe("你好");
		const rows = editor.render(56);
		expect(stripTerminalSequences(rows[0] ?? "")).toMatch(/^╭/u);
		expect(rows.join("\n")).not.toContain("你好");
		for (const row of rows) expect(visibleWidth(row)).toBe(56);
	});

	it("uses the same Step frame for OAuth and summary surfaces", () => {
		initTheme("step-blue");
		const login = new LoginDialogComponent(fakeTui, "step", () => {}, "Step", "Step setup", "step");
		login.showDetails(["Open the browser to continue."]);
		const loginRows = login.render(56);
		expect(stripTerminalSequences(loginRows[0] ?? "")).toMatch(/^╭/u);
		const secret = new LoginDialogComponent(fakeTui, "step", () => {}, "Step", "Step setup", "step");
		const secretPromise = secret.showPrompt("API key", "sk-…", {
			secret: true,
		});
		secret.handleInput("secret-value");
		const secretText = secret.render(56).join("\n");
		expect(secretText).not.toContain("secret-value");
		expect(stripTerminalSequences(secretText)).toContain("••••••••");
		secret.handleInput("\u001b");
		void secretPromise.catch(() => undefined);

		const compaction = new CompactionSummaryMessageComponent(
			{
				role: "compactionSummary",
				tokensBefore: 1234,
				summary: "A compact summary",
				timestamp: 0,
			},
			getMarkdownTheme(),
			{ presentation: "step" },
		);
		const branch = new BranchSummaryMessageComponent(
			{
				role: "branchSummary",
				fromId: "root",
				summary: "A branch summary",
				timestamp: 0,
			},
			getMarkdownTheme(),
			{ presentation: "step" },
		);
		expect(stripTerminalSequences(compaction.render(56)[0] ?? "")).toMatch(/^╭/u);
		expect(stripTerminalSequences(branch.render(56)[0] ?? "")).toMatch(/^╭/u);
	});

	it("removes Pi Loader's reserved blank row for Step status", () => {
		initTheme("step-blue");
		const working = new WorkingStatusIndicator(fakeTui, "Working", undefined, "step");
		const compaction = new CompactionStatusIndicator(fakeTui, "manual", "step");
		const branch = new BranchSummaryStatusIndicator(fakeTui, "step");
		for (const indicator of [working, compaction, branch]) {
			const rows = indicator.render(80);
			expect(rows).toHaveLength(1);
			expect(stripTerminalSequences(rows[0] ?? "").trim()).not.toBe("");
			indicator.dispose();
		}
	});
});
