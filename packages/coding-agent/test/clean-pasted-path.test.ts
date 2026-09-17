import { describe, expect, it } from "vitest";
import { cleanPastedPath, isImageFilePath } from "../src/utils/clipboard-image.ts";

// Terminals shell-escape spaces/parens when a file path is pasted or dragged
// (e.g. "a\ file\ \(1\).png"). cleanPastedPath undoes that so the path resolves.
describe("cleanPastedPath", () => {
	it("unescapes spaces and parens on macOS/Linux", () => {
		expect(cleanPastedPath("1280X1280\\ \\(1\\)_副本.PNG", "darwin")).toBe("1280X1280 (1)_副本.PNG");
		expect(cleanPastedPath("/Users/x/a\\ b.png", "linux")).toBe("/Users/x/a b.png");
	});

	it("strips surrounding single or double quotes", () => {
		expect(cleanPastedPath('"/Users/x/c d.png"', "darwin")).toBe("/Users/x/c d.png");
		expect(cleanPastedPath("'/Users/x/c d.png'", "darwin")).toBe("/Users/x/c d.png");
	});

	it("preserves a doubled backslash as one literal backslash", () => {
		expect(cleanPastedPath("a\\\\b.png", "linux")).toBe("a\\b.png");
	});

	it("leaves backslashes intact on Windows (they are path separators)", () => {
		expect(cleanPastedPath("C:\\Users\\a\\pic.png", "win32")).toBe("C:\\Users\\a\\pic.png");
	});

	it("leaves an ordinary path unchanged", () => {
		expect(cleanPastedPath("/tmp/plain.png", "darwin")).toBe("/tmp/plain.png");
	});

	it("makes an escaped image path recognizable by isImageFilePath", () => {
		expect(isImageFilePath(cleanPastedPath("shot\\ \\(2\\).jpeg", "darwin"))).toBe(true);
	});
});
