import { CURSOR_MARKER, setKeybindings, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { STEP_EDITOR_PLACEHOLDER, StepEditor } from "../src/ui/view/editor/step-editor.ts";
import { initTheme, theme } from "../../../packages/coding-agent/src/theme/theme.ts";

function createEditor(width = 80, rows = 24): StepEditor {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const tui = {
		terminal: { columns: width, rows },
		requestRender: () => {},
	} as never;
	return new StepEditor(
		tui,
		{
			borderColor: (text) => text,
			selectList: {
				selectedPrefix: (text) => text,
				selectedText: (text) => text,
				description: (text) => text,
				scrollInfo: (text) => text,
				noMatch: (text) => text,
			},
		},
		keybindings,
	);
}

function stripSgr(line: string): string {
	// eslint-disable-next-line no-control-regex
	return line.replaceAll(/\x1b\[[0-9;]*m/g, "");
}

afterEach(() => {
	initTheme("dark");
});

describe("StepEditor", () => {
	it("renders the Step frame rules and placeholder without changing width", () => {
		initTheme("step");
		const editor = createEditor();
		const lines = editor.render(80);

		expect(lines).toHaveLength(3);
		// Top and bottom are plain rules and the content is inset, so a terminal
		// selection of the composer copies the prompt without box drawing.
		expect(stripSgr(lines[0] ?? "")).toBe("─".repeat(80));
		expect(stripSgr(lines[2] ?? "")).toBe("─".repeat(80));
		expect(stripSgr(lines[1] ?? "").startsWith("❯ ")).toBe(true);
		expect(lines[1]).not.toContain("│");
		expect(lines[1]).toContain(STEP_EDITOR_PLACEHOLDER);
		for (const line of lines) expect(visibleWidth(line)).toBe(80);
	});

	it("marks the first row and aligns wrapped rows to the same content column", () => {
		initTheme("step");
		const editor = createEditor();
		editor.setText("重构 renderMessage，拆成三个小函数，并且补上单元测试。".repeat(3));
		const rows = editor
			.render(80)
			.slice(1, -1)
			.map((row) => stripSgr(row));

		expect(rows.length).toBeGreaterThan(1);
		expect(rows[0]?.startsWith("❯ ")).toBe(true);
		// The marker is exactly as wide as the inset, so continuations line up.
		for (const row of rows.slice(1)) expect(row.startsWith("  ")).toBe(true);
	});

	it("keeps wrapped rows free of side rails so a terminal selection copies the prompt alone", () => {
		initTheme("step");
		const editor = createEditor();
		editor.setText("重构 renderMessage，拆成三个小函数，并且补上单元测试。".repeat(3));
		const lines = editor.render(80);

		expect(lines.length).toBeGreaterThan(3);
		for (const row of lines.slice(1, -1)) expect(row).not.toContain("│");
		for (const line of lines) expect(visibleWidth(line)).toBe(80);
	});

	it("shows bash-mode hints for a bare ! or !! prefix", () => {
		initTheme("step");
		const editor = createEditor();

		editor.setText("!");
		const bangLines = editor.render(80);
		expect(bangLines[1]).toContain("run a shell command (Esc to exit)");
		expect(bangLines[1]).not.toContain(STEP_EDITOR_PLACEHOLDER);

		editor.setText("!!");
		const excludedLines = editor.render(80);
		expect(excludedLines[1]).toContain("run a shell command, hidden from the model (Esc to exit)");

		for (const line of [...bangLines, ...excludedLines]) expect(visibleWidth(line)).toBe(80);
	});

	it("hides the bash hint once a command follows the prefix", () => {
		initTheme("step");
		const editor = createEditor();
		editor.setText("!ls");
		const lines = editor.render(80);

		expect(lines[1]).not.toContain("run a shell command");
		for (const line of lines) expect(visibleWidth(line)).toBe(80);
	});

	it("paints the frame rules with the editor's borderColor", () => {
		initTheme("step");
		const editor = createEditor();
		editor.borderColor = (str: string) => `<b>${str}</b>`;
		const lines = editor.render(80);

		expect(lines[0]).toContain("<b>");
		expect(lines[2]).toContain("<b>");
	});

	it("keeps native editor text and CJK width handling inside the frame", () => {
		initTheme("step");
		const editor = createEditor();
		editor.setText("你好，世界");
		const lines = editor.render(20);

		expect(lines.join("\n")).toContain("你好，世界");
		expect(lines.join("\n")).not.toContain(STEP_EDITOR_PLACEHOLDER);
		expect(lines.join("\n")).not.toContain("\x1b[40m");
		expect(lines.join("\n")).not.toContain("\x1b[97m");
		for (const line of lines) expect(visibleWidth(line)).toBe(20);
	});

	it("falls back to pi-tui's compact rendering in a narrow terminal", () => {
		initTheme("step");
		const editor = createEditor();
		const lines = editor.render(7);

		// The frame needs room for its inset on both sides; below that the native
		// compact editor renders alone, without the Step placeholder.
		expect(lines.join("\n")).not.toContain(STEP_EDITOR_PLACEHOLDER);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(7);
	});

	it("keeps narrow CJK input safe when editor padding leaves no frame", () => {
		initTheme("step");
		for (const [width, padding, text] of [
			[9, 2, "中文输入"],
			[7, 3, "\t"],
		] as const) {
			const editor = createEditor();
			editor.setPaddingX(padding);
			editor.focused = true;
			editor.setText(text);

			const lines = editor.render(width);

			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(lines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
		}
	});

	it("preserves the native cursor marker when clipping an undersized fallback", () => {
		initTheme("step");
		const editor = createEditor();
		editor.focused = true;
		editor.setText("a");

		const lines = editor.render(1);

		expect(lines.every((line) => visibleWidth(line) <= 1)).toBe(true);
		expect(lines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
	});

	it("tints the leading slash command in the accent tone without changing width", () => {
		initTheme("step");
		const editor = createEditor();
		editor.setText("/model hi");
		const lines = editor.render(80);

		expect(lines[1]).toContain(theme.fg("accent", "/model"));
		expect(stripSgr(lines[1] ?? "")).toContain("/model hi");
		for (const line of lines) expect(visibleWidth(line)).toBe(80);
	});

	it("keeps plain text and a bare slash trigger untinted", () => {
		initTheme("step");
		const editor = createEditor();
		editor.setText("plain text with /model inside");
		expect(editor.render(80)[1]).not.toContain(theme.fg("accent", "/model"));
		editor.setText("/");
		expect(editor.render(80)[1]).not.toContain(theme.fg("accent", "/"));
	});

	it("skips the tint while the cursor overlays the token", () => {
		initTheme("step");
		const editor = createEditor();
		editor.setText("/model hi");
		for (let i = 0; i < 4; i += 1) editor.handleInput("\x1b[D"); // left into the token
		const lines = editor.render(80);
		expect(lines[1]).not.toContain(theme.fg("accent", "/model"));
		expect(stripSgr(lines[1] ?? "")).toContain("/model hi");
	});

	it("delegates printable input and submit to the inherited editor", () => {
		initTheme("step");
		const editor = createEditor();
		let submitted = "";
		editor.onSubmit = (text) => {
			submitted = text;
		};

		editor.handleInput("你");
		editor.handleInput("好");
		expect(editor.getText()).toBe("你好");
		editor.handleInput("\r");
		expect(submitted).toBe("你好");
	});
});
