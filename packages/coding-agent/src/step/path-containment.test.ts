import path from "node:path";
import { expect, test } from "vitest";
import { isPathContained } from "./path-containment.ts";

const root = path.resolve("/tmp/step-root");

test.each([
	[".", true],
	["plugins/a", true],
	["..", false],
	["../x", false],
	["../step-root-sibling", false],
	["..hidden", true],
])("%s inside the root: %s", (relative, expected) => {
	expect(isPathContained(root, path.resolve(root, relative))).toBe(expected);
});

test("an absolute path elsewhere is not contained", () => {
	expect(isPathContained(root, path.resolve("/etc"))).toBe(false);
});
