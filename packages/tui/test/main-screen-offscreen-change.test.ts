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

	it("keeps terminal scrollback and the reader's position when the document length changes above the viewport", async () => {
		const harness = createHarness(ROWS);
		// The first frame's writes have to reach the terminal before it can be scrolled,
		// or scrollLines() moves a buffer that does not hold the document yet.
		await harness.terminal.flush();
		const redrawsBefore = harness.tui.fullRedraws;
		const bottom = harness.terminal.getViewportTop();
		// The reader scrolled the terminal viewport up before the next frame lands.
		harness.terminal.scrollLines(-10);
		await harness.terminal.flush();
		const viewportTopBefore = harness.terminal.getViewportTop();
		const viewportBefore = harness.terminal.getViewport();
		assert.strictEqual(viewportTopBefore, bottom - 10, "the reader must actually have scrolled up");
		harness.resetWritten();

		// The shape of a settled assistant message reflowing when generation completes:
		// an off-screen row is rewritten and the document grows by one line.
		harness.transcript.lines = [
			...harness.transcript.lines.slice(0, 5),
			"settled row",
			...harness.transcript.lines.slice(5),
		];
		harness.tui.renderNow();
		await harness.terminal.flush();

		assert.strictEqual(harness.tui.fullRedraws, redrawsBefore, "must not replay the document");
		assert.ok(!harness.written().includes(CLEAR_SCROLLBACK), "must not clear terminal scrollback");
		assert.strictEqual(harness.terminal.getViewportTop(), viewportTopBefore, "viewport must not move");
		assert.deepStrictEqual(harness.terminal.getViewport(), viewportBefore, "visible rows must not change");
		// The frame wrote nothing, so the mirror is the only record of the new document:
		// a stale one corrupts the next incremental frame even when the screen looks right.
		const mirror = harness.tui as unknown as { previousViewportTop: number; previousLines: string[] };
		const documentLength =
			harness.transcript.lines.length + harness.status.lines.length + harness.dialog.lines.length + 1;
		assert.strictEqual(mirror.previousLines.length, documentLength, "the mirror must hold the new document");
		assert.ok(
			mirror.previousLines.some((line) => line.includes("settled row")),
			"the mirror must contain the inserted row",
		);
		assert.strictEqual(mirror.previousViewportTop, documentLength - ROWS, "the mirror must track the new window");

		// The bookkeeping the skipped frame left behind has to describe the new document:
		// the next ordinary edit must reach its row without replaying the document.
		harness.resetWritten();
		harness.dialog.lines = [...harness.dialog.lines.slice(0, 2), "dialog edited", ...harness.dialog.lines.slice(3)];
		harness.tui.renderNow();
		harness.terminal.scrollLines(200);
		const screen = await harness.terminal.flushAndGetViewport();
		assert.strictEqual(harness.tui.fullRedraws, redrawsBefore, "the edit must stay on the differential path");
		assert.ok(!harness.written().includes(CLEAR_SCROLLBACK), "the edit must not clear terminal scrollback");
		assert.ok(screen.includes("dialog edited"), "the edit after the skipped frame must reach its row");
		assert.ok(!screen.includes("dialog 2"), "the replaced row must not survive");
		harness.tui.stop({ preserveScreen: true });
	});

	it("repairs the rows a settle frame changed instead of replaying the document", async () => {
		// The real dock is a handful of rows, so the status line sits inside the viewport.
		const harness = createHarness(5);
		await harness.terminal.flush();
		const redrawsBefore = harness.tui.fullRedraws;
		harness.terminal.scrollLines(-5);
		await harness.terminal.flush();
		const viewportTopBefore = harness.terminal.getViewportTop();
		harness.resetWritten();

		// The settled-message shape: a summary row is inserted above the viewport in the same
		// frame that the dock's status line turns into "Done". Only that visible row changed,
		// so it is repaired in place and scrollback survives.
		harness.transcript.lines = [
			...harness.transcript.lines.slice(0, 5),
			"summary row",
			...harness.transcript.lines.slice(5),
		];
		harness.status.lines = ["Done"];
		harness.tui.renderNow();
		await harness.terminal.flush();

		assert.strictEqual(harness.tui.fullRedraws, redrawsBefore, "must not replay the document");
		assert.ok(!harness.written().includes(CLEAR_SCROLLBACK), "must not clear terminal scrollback");
		assert.strictEqual(harness.terminal.getViewportTop(), viewportTopBefore, "viewport must not move");
		const screen = await harness.terminal.flushAndGetViewport();
		assert.ok(screen.includes("Done"), "the changed row must be repainted");
		assert.ok(!screen.includes("spinner 0"), "the previous row content must be gone");
		// The repaired frame updated the mirror, so the next ordinary edit still lands on its
		// row instead of being papered over by another replay.
		const mirror = harness.tui as unknown as { previousViewportTop: number; previousLines: string[] };
		const documentLength =
			harness.transcript.lines.length + harness.status.lines.length + harness.dialog.lines.length + 1;
		assert.strictEqual(mirror.previousLines.length, documentLength, "the mirror must hold the new document");
		assert.strictEqual(mirror.previousViewportTop, documentLength - ROWS, "the mirror must track the new window");
		harness.resetWritten();
		harness.dialog.lines = [...harness.dialog.lines.slice(0, 3), "dialog later", ...harness.dialog.lines.slice(4)];
		harness.tui.renderNow();
		harness.terminal.scrollLines(200);
		const afterEdit = await harness.terminal.flushAndGetViewport();
		assert.strictEqual(harness.tui.fullRedraws, redrawsBefore, "the later edit must stay on the differential path");
		assert.ok(!harness.written().includes(CLEAR_SCROLLBACK), "the later edit must not clear terminal scrollback");
		assert.deepStrictEqual(
			afterEdit,
			[...harness.transcript.lines, ...harness.status.lines, ...harness.dialog.lines, "footer"].slice(-ROWS),
			"the screen must match the document after the later edit",
		);
		harness.tui.stop({ preserveScreen: true });
	});

	it("replays the document when the length change also alters the visible window", async () => {
		const harness = createHarness(ROWS);
		await harness.terminal.flush();
		const redrawsBefore = harness.tui.fullRedraws;
		harness.terminal.scrollLines(-5);
		await harness.terminal.flush();
		harness.resetWritten();

		// The window itself changes, so the frame cannot be caught up by bookkeeping alone:
		// it replays the document, and every row still has to be reachable afterwards.
		harness.status.lines = ["spinner 1"];
		harness.dialog.lines = [...harness.dialog.lines, "dialog grown a", "dialog grown b", "dialog grown c"];
		harness.tui.renderNow();
		await harness.terminal.flush();

		assert.ok(harness.tui.fullRedraws > redrawsBefore, "a changed window must replay the document");
		const rowsAfter = harness.terminal.getScrollBuffer().filter((row) => row.length > 0);
		for (const row of [...harness.transcript.lines, ...harness.status.lines, ...harness.dialog.lines, "footer"]) {
			assert.ok(rowsAfter.includes(row), `document row ${JSON.stringify(row)} must not be dropped`);
		}
		assert.strictEqual(new Set(rowsAfter).size, rowsAfter.length, "no row may be duplicated");
		harness.tui.stop({ preserveScreen: true });
	});

	it("does not drop rows when the document grows by a whole screen in one frame", async () => {
		const harness = createHarness(ROWS);
		await harness.terminal.flush();
		const redrawsBefore = harness.tui.fullRedraws;
		harness.resetWritten();

		// More rows leave the screen than the screen holds, so no scroll can move them into
		// scrollback one by one: losing no document row wins over keeping the position.
		const grown = Array.from({ length: ROWS + 5 }, (_, index) => `grown ${index}`);
		harness.status.lines = ["spinner 1"];
		harness.dialog.lines = [...harness.dialog.lines, ...grown];
		harness.tui.renderNow();
		await harness.terminal.flush();

		assert.ok(harness.tui.fullRedraws > redrawsBefore, "a whole-screen change must replay the document");
		const rowsAfter = harness.terminal.getScrollBuffer().filter((row) => row.length > 0);
		for (const row of [...harness.transcript.lines, ...harness.status.lines, ...harness.dialog.lines, "footer"]) {
			assert.ok(rowsAfter.includes(row), `document row ${JSON.stringify(row)} must not be dropped`);
		}
		harness.tui.stop({ preserveScreen: true });
	});

	it("clears stale rows when a settled document shrinks below one screen", async () => {
		const harness = createHarness(ROWS);
		await harness.terminal.flush();
		// Generation settles into a document shorter than the terminal: everything moves
		// up, and only the rows still on screen may remain.
		harness.transcript.lines = Array.from({ length: 3 }, (_, index) => `transcript ${index}`);
		harness.dialog.lines = Array.from({ length: 3 }, (_, index) => `dialog ${index}`);
		harness.tui.renderNow();
		await harness.terminal.flush();

		harness.transcript.lines = ["transcript 0 edited", "transcript 1", "transcript 2"];
		harness.tui.renderNow();
		await harness.terminal.flush();

		const viewport = await harness.terminal.flushAndGetViewport();
		assert.deepStrictEqual(
			viewport.filter((row) => row.length > 0),
			[
				"transcript 0 edited",
				"transcript 1",
				"transcript 2",
				"spinner 0",
				"dialog 0",
				"dialog 1",
				"dialog 2",
				"footer",
			],
			"the screen must match the shrunken document",
		);
		harness.tui.stop({ preserveScreen: true });
	});

	it("refuses an over-wide line instead of letting the repaint wrap it", async () => {
		const harness = createHarness(ROWS);
		await harness.terminal.flush();
		harness.status.lines = ["spinner 1"];
		harness.dialog.lines = [...harness.dialog.lines, "x".repeat(COLS + 1)];

		assert.throws(() => harness.tui.renderNow(), /exceeds terminal width/);
		harness.tui.stop({ preserveScreen: true });
	});
});
