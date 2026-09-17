import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { visibleWidth } from "../src/utils.ts";

// Horizontal alignment of the Text component. Left must stay byte-identical to
// the pre-alignment behavior; center/right distribute the leftover width.
describe("Text component alignment", () => {
	it("left align (default) is unchanged: content flush left after paddingX", () => {
		const width = 40;
		const text = new Text("hello", 1, 0);
		const [line] = text.render(width);
		assert.strictEqual(visibleWidth(line), width);
		// paddingX=1 space, then the content, then trailing pad.
		assert.strictEqual(line, ` hello${" ".repeat(width - 1 - "hello".length)}`);
	});

	it("center align puts equal-ish slack on both sides", () => {
		const width = 41; // odd width so floor() is exercised
		const content = "hello"; // visible width 5
		const text = new Text(content, 0, 0, undefined, "center");
		const [line] = text.render(width);
		assert.strictEqual(visibleWidth(line), width);
		const slack = width - content.length; // 36
		const left = Math.floor(slack / 2); // 18
		assert.strictEqual(line, `${" ".repeat(left)}${content}${" ".repeat(slack - left)}`);
	});

	it("right align pushes content to the far right (inside paddingX)", () => {
		const width = 30;
		const content = "hi";
		const text = new Text(content, 0, 0, undefined, "right");
		const [line] = text.render(width);
		assert.strictEqual(visibleWidth(line), width);
		assert.strictEqual(line, `${" ".repeat(width - content.length)}${content}`);
	});

	it("alignment measures visible width, ignoring ANSI escapes", () => {
		const width = 20;
		const raw = "ok";
		const colored = `\x1b[2m${raw}\x1b[0m`; // dim wrapper, 0 visible width added
		const text = new Text(colored, 0, 0, undefined, "center");
		const [line] = text.render(width);
		assert.strictEqual(visibleWidth(line), width);
		const left = Math.floor((width - raw.length) / 2);
		// The colored token sits at the centered offset.
		assert.strictEqual(line, `${" ".repeat(left)}${colored}${" ".repeat(width - raw.length - left)}`);
	});
});
