import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Lines implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

describe("TUI shrinking content", () => {
	it("clears all rendered lines when content shrinks to zero", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const content = new Lines(["first", "second", "third"]);
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		assert.ok(terminal.getViewport().some((line) => line.includes("first")));
		assert.ok(terminal.getViewport().some((line) => line.includes("second")));
		assert.ok(terminal.getViewport().some((line) => line.includes("third")));

		tui.clear();
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(!viewport.some((line) => line.includes("first")), "first line should be cleared");
		assert.ok(!viewport.some((line) => line.includes("second")), "second line should be cleared");
		assert.ok(!viewport.some((line) => line.includes("third")), "third line should be cleared");

		tui.stop();
	});

	it("keeps the transcript anchored to the bottom row across an overlay dialog", async () => {
		// A transcript taller than the terminal has already scrolled the screen, so growing the
		// rendered document scrolls it further and the shrink on dismissal cannot scroll it back.
		// Overlays composite onto the rows the document already occupies, so its length never
		// changes and the last row stays where it was.
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const transcript = new Lines(Array.from({ length: 40 }, (_, index) => `history ${index}`));
		const editor = new Lines(["editor"]);
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(terminal.getViewport().at(-1), "editor");

		const handle = tui.showOverlay(new Lines(Array.from({ length: 8 }, (_, index) => `dialog ${index}`)));
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("dialog 7")));

		handle.hide();
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(!viewport.some((line) => line.includes("dialog")), "dialog rows should be gone");
		assert.strictEqual(viewport.at(-1), "editor", "editor should still hold the bottom row");

		tui.stop();
	});
});
