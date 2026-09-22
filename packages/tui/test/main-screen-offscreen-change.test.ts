import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const COLS = 60;
const ROWS = 20;
const CLEAR_SCROLLBACK = "\x1b[3J";

class Lines implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

interface Harness {
	terminal: VirtualTerminal;
	tui: TuiMainScreen;
	transcript: Lines;
	status: Lines;
	dialog: Lines;
	written(): string;
	resetWritten(): void;
}

/**
 * A document whose tail (dialog + footer) fills the screen, so the transcript
 * and the status row above it sit outside the visible viewport.
 */
function createHarness(dialogHeight: number): Harness {
	const terminal = new VirtualTerminal(COLS, ROWS);
	let written = "";
	const write = terminal.write.bind(terminal);
	terminal.write = (data: string): void => {
		written += data;
		write(data);
	};

	const tui = new TuiMainScreen(terminal);
	const transcript = new Lines(Array.from({ length: 40 }, (_, index) => `transcript ${index}`));
	const status = new Lines(["spinner 0"]);
	const dialog = new Lines(Array.from({ length: dialogHeight }, (_, index) => `dialog ${index}`));
	tui.addChild(transcript);
	tui.addChild(status);
	tui.addChild(dialog);
	tui.addChild(new Lines(["footer"]));
	tui.start();
	tui.renderNow();

	return {
		terminal,
		tui,
		transcript,
		status,
		dialog,
		written: () => written,
		resetWritten: () => {
			written = "";
		},
	};
}

describe("main screen changes above the viewport", () => {
	it("does not clear scrollback when only off-screen rows change", async () => {
		const harness = createHarness(ROWS);
		const redrawsBefore = harness.tui.fullRedraws;
		const viewportBefore = await harness.terminal.flushAndGetViewport();
		harness.resetWritten();

		for (let tick = 1; tick <= 5; tick++) {
			harness.status.lines = [`spinner ${tick}`];
			harness.tui.renderNow();
		}

		assert.strictEqual(harness.tui.fullRedraws, redrawsBefore);
		assert.ok(!harness.written().includes(CLEAR_SCROLLBACK));
		assert.deepStrictEqual(await harness.terminal.flushAndGetViewport(), viewportBefore);
		harness.tui.stop({ preserveScreen: true });
	});

	it("repaints the visible rows when a change straddles the viewport top", async () => {
		const harness = createHarness(ROWS);
		const redrawsBefore = harness.tui.fullRedraws;
		harness.resetWritten();

		// One frame changing both an off-screen row and an on-screen row.
		harness.status.lines = ["spinner 1"];
		harness.dialog.lines = harness.dialog.lines.map((line, index) =>
			index === harness.dialog.lines.length - 1 ? "dialog tail changed" : line,
		);
		harness.tui.renderNow();

		assert.strictEqual(harness.tui.fullRedraws, redrawsBefore);
		assert.ok(!harness.written().includes(CLEAR_SCROLLBACK));
		const viewport = await harness.terminal.flushAndGetViewport();
		assert.ok(viewport.includes("dialog tail changed"));
		assert.strictEqual(viewport[viewport.length - 1], "footer");
		harness.tui.stop({ preserveScreen: true });
	});

	it("still repaints normally when the whole document fits on screen", async () => {
		const harness = createHarness(3);
		harness.transcript.lines = [];
		harness.tui.renderNow();
		harness.resetWritten();

		harness.status.lines = ["spinner 1"];
		harness.tui.renderNow();

		const viewport = await harness.terminal.flushAndGetViewport();
		assert.ok(viewport.includes("spinner 1"));
		assert.ok(!harness.written().includes(CLEAR_SCROLLBACK));
		harness.tui.stop({ preserveScreen: true });
	});

	it("falls back to a full redraw when the document length changes above the viewport", async () => {
		const harness = createHarness(ROWS);
		const redrawsBefore = harness.tui.fullRedraws;
		harness.resetWritten();

		// A transcript append shifts every row under it, so the visible window no longer
		// maps to the same terminal rows and the clamp would leave the screen stale.
		harness.transcript.lines = [...harness.transcript.lines, "transcript appended"];
		harness.tui.renderNow();

		assert.strictEqual(harness.tui.fullRedraws, redrawsBefore + 1);
		const viewport = await harness.terminal.flushAndGetViewport();
		assert.strictEqual(viewport[viewport.length - 1], "footer");
		harness.tui.stop({ preserveScreen: true });
	});
});
