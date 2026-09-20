import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.ts";
import { CURSOR_MARKER } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

test("editor styling receives source offsets without changing layout or cursor", () => {
	const source = "你好 abcdefghijklmnop\nsecond line";
	class StyledEditor extends Editor {
		protected override styleText(text: string, line: number, startIndex: number): string {
			assert.equal(text, source.split("\n")[line].slice(startIndex, startIndex + text.length));
			return `\x1b[34m${text}\x1b[39m`;
		}
	}
	const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
	const plain = new Editor(tui, defaultEditorTheme);
	const styled = new StyledEditor(tui, defaultEditorTheme);
	for (const editor of [plain, styled]) {
		editor.focused = true;
		editor.setText(source);
		editor.handleInput("\x01");
	}
	for (const width of [6, 12, 80]) {
		const actual = styled.render(width);
		assert.deepEqual(actual.map(stripVTControlCharacters), plain.render(width).map(stripVTControlCharacters));
		assert(actual.some((line) => line.includes(CURSOR_MARKER)));
		assert(actual.every((line) => visibleWidth(line) <= width));
	}
});
