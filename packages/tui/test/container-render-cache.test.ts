import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Spacer } from "../src/components/spacer.ts";
import { Text } from "../src/components/text.ts";
import { type Component, Container, isIncrementalRenderDisabled } from "../src/tui.ts";

/** Returns a fresh array on every render, the way a spinner or streaming row does. */
class Churning implements Component {
	private line: string;

	constructor(line: string) {
		this.line = line;
	}

	setLine(line: string): void {
		this.line = line;
	}

	render(): string[] {
		return [this.line];
	}

	invalidate(): void {}
}

/** Padding-free text so each component is exactly one line. */
const row = (text: string): Text => new Text(text, 0, 0);

/** Text pads to the full width, so compare the visible content. */
const rows = (lines: string[]): string[] => lines.map((line) => line.trim());

describe(
	"Container incremental render cache",
	{ skip: isIncrementalRenderDisabled() ? "incremental rendering disabled" : false },
	() => {
		it("returns the same array while no child changed and reports a dirty start past the end", () => {
			const container = new Container();
			container.addChild(row("one"));
			container.addChild(row("two"));

			const first = container.render(40);
			assert.equal(container.renderDirtyStart, 0);

			const second = container.render(40);
			assert.equal(second, first, "an unchanged container must hand back the same array");
			assert.equal(container.renderDirtyStart, first.length);
		});

		it("reports where a changed child starts and keeps the prefix lines identical", () => {
			const container = new Container();
			container.addChild(row("head"));
			const tail = row("tail");
			container.addChild(tail);
			const first = container.render(40);

			tail.setText("tail changed");
			const second = container.render(40);
			assert.notEqual(second, first);
			assert.equal(container.renderDirtyStart, 1);
			assert.deepEqual(second.slice(0, 1), first.slice(0, 1));
			assert.deepEqual(rows(second), ["head", "tail changed"]);
		});

		it("reaches into a dirty child that reports its own dirty start", () => {
			const outer = new Container();
			const inner = new Container();
			inner.addChild(row("inner head"));
			const innerTail = row("inner tail");
			inner.addChild(innerTail);
			outer.addChild(inner);
			outer.render(40);

			innerTail.setText("inner tail changed");
			const second = outer.render(40);
			// The outer container must not treat the whole inner container as dirty.
			assert.equal(outer.renderDirtyStart, 1);
			assert.deepEqual(rows(second), ["inner head", "inner tail changed"]);
		});

		it("treats a child that rebuilds every render as dirty from its first line", () => {
			const container = new Container();
			container.addChild(row("stable"));
			const churn = new Churning("frame 0");
			container.addChild(churn);
			const stableBefore = container.render(40);

			churn.setLine("frame 1");
			const second = container.render(40);
			assert.equal(container.renderDirtyStart, 1);
			assert.deepEqual(rows(second), ["stable", "frame 1"]);
			assert.equal(rows(second)[0], "stable");
			assert.equal(rows(stableBefore).at(-1), "frame 0");
		});

		it("rebuilds from scratch when the child count or the width changes", () => {
			const container = new Container();
			container.addChild(row("one"));
			assert.equal(container.render(40).length, 1);

			container.addChild(row("two"));
			assert.equal(container.render(40).length, 2);
			assert.equal(container.renderDirtyStart, 0);

			container.removeChild(container.children[0]);
			assert.equal(container.render(40).length, 1);
			assert.equal(container.renderDirtyStart, 0);

			assert.equal(container.render(80).length, 1);
			assert.equal(container.renderDirtyStart, 0);
		});

		it("drops the cache when the children change", () => {
			const container = new Container();
			container.addChild(row("one"));
			const first = container.render(40);
			container.addChild(row("two"));
			assert.notEqual(container.render(40), first);

			container.removeChild(container.children[1]);
			assert.equal(container.render(40).length, 1);
			container.clear();
			assert.deepEqual(container.render(40), []);
		});

		it("rebuilds after invalidate so a theme change is picked up", () => {
			const container = new Container();
			container.addChild(row("one"));
			const first = container.render(40);
			container.invalidate();
			assert.notEqual(container.render(40), first);
			assert.equal(container.renderDirtyStart, 0);
		});

		it("keeps Box and Spacer output stable across renders", () => {
			const box = new Box(1, 1);
			box.addChild(row("boxed"));
			const firstBox = box.render(40);
			assert.equal(box.render(40), firstBox);

			const spacer = new Spacer(2);
			const firstSpacer = spacer.render(40);
			assert.equal(spacer.render(40), firstSpacer);
			spacer.setLines(3);
			assert.equal(spacer.render(40).length, 3);
			assert.notEqual(spacer.render(40), firstSpacer);
		});
	},
);

/**
 * Reflows its own rows into a differently shaped array the way Step's message
 * components reshape Pi's output. super.render() reports a dirty start as an index
 * into the NATIVE rows, so the override has to reset it: a parent that reads
 * renderDirtyStart would otherwise skip lines that did change.
 */
class LeadingBlankTrimmer extends Container {
	private readonly body: Text;

	constructor() {
		super();
		this.addChild(new Spacer(1));
		this.body = row("first body");
		this.addChild(this.body);
	}

	setBody(line: string): void {
		this.body.setText(line);
	}

	override render(width: number): string[] {
		const native = super.render(width);
		this.renderDirtyStart = 0;
		const firstContent = native.findIndex((line) => line.trim().length > 0);
		return firstContent <= 0 ? native : native.slice(firstContent);
	}
}

describe("Container child that reflows into a different length", () => {
	it("gives an unchanged empty Text a stable array", () => {
		const blank = new Text("", 1, 0);
		const first = blank.render(40);
		assert.deepEqual(first, []);
		assert.equal(blank.render(40), first, "an empty Text must keep handing back the same array");
	});

	it("leaves no stale line when the reflowed child changes", () => {
		const parent = new Container();
		parent.addChild(row("head"));
		const reflow = new LeadingBlankTrimmer();
		parent.addChild(reflow);
		parent.addChild(row("tail"));
		assert.deepEqual(rows(parent.render(40)), ["head", "first body", "tail"]);

		reflow.setBody("second body");
		assert.deepEqual(rows(parent.render(40)), ["head", "second body", "tail"]);
	});

	it("reports a dirty start that indexes the reflowed array", () => {
		const parent = new Container();
		parent.addChild(row("head"));
		const reflow = new LeadingBlankTrimmer();
		parent.addChild(reflow);
		parent.render(40);

		reflow.setBody("second body");
		parent.render(40);
		// The reflow drops the leading blank row, so the native dirty start (1) would
		// point past the single row the reflowed child now returns.
		assert.equal(reflow.renderDirtyStart, 0);
	});
});
