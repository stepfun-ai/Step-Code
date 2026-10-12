import { describe, expect, it } from "vitest";
import {
	describeFrontmatterError,
	formatFrontmatterError,
	hasUnquotedColonInDescription,
	parseFrontmatter,
	stripFrontmatter,
} from "../src/utils/frontmatter.ts";

describe("parseFrontmatter", () => {
	it("parses keys, strips quotes, and returns body", () => {
		const input = "---\nname: \"skill-name\"\ndescription: 'A desc'\nfoo-bar: value\n---\n\nBody text";
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(input);
		expect(frontmatter.name).toBe("skill-name");
		expect(frontmatter.description).toBe("A desc");
		expect(frontmatter["foo-bar"]).toBe("value");
		expect(body).toBe("Body text");
	});

	it("normalizes newlines and handles CRLF", () => {
		const input = "---\r\nname: test\r\n---\r\nLine one\r\nLine two";
		const { body } = parseFrontmatter<Record<string, string>>(input);
		expect(body).toBe("Line one\nLine two");
	});

	it("throws on invalid YAML frontmatter", () => {
		const input = "---\nfoo: [bar\n---\nBody";
		expect(() => parseFrontmatter<Record<string, string>>(input)).toThrow(/at line 1, column 10/);
	});

	it("parses | multiline yaml syntax", () => {
		const input = "---\ndescription: |\n  Line one\n  Line two\n---\n\nBody";
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(input);
		expect(frontmatter.description).toBe("Line one\nLine two\n");
		expect(body).toBe("Body");
	});

	it("returns original content when frontmatter is missing or unterminated", () => {
		const noFrontmatter = "Just text\nsecond line";
		const missingEnd = "---\nname: test\nBody without terminator";
		const resultNoFrontmatter = parseFrontmatter<Record<string, string>>(noFrontmatter);
		const resultMissingEnd = parseFrontmatter<Record<string, string>>(missingEnd);
		expect(resultNoFrontmatter.body).toBe("Just text\nsecond line");
		expect(resultMissingEnd.body).toBe(
			"---\nname: test\nBody without terminator".replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
		);
	});

	it("returns empty object for empty or comment-only frontmatter", () => {
		const input = "---\n# just a comment\n---\nBody";
		const { frontmatter } = parseFrontmatter(input);
		expect(frontmatter).toEqual({});
	});
});

describe("frontmatter error diagnostics", () => {
	const unquotedColon = "---\nname: search-first\ndescription: Search the web: before guessing\n---\nBody";

	const captureError = (content: string): unknown => {
		try {
			parseFrontmatter(content);
		} catch (error) {
			return error;
		}
		throw new Error("expected parseFrontmatter to throw");
	};

	it("flattens a YAML error onto a single line with file-relative coordinates", () => {
		const details = describeFrontmatterError(captureError(unquotedColon));

		expect(details).toEqual({
			line: 3,
			column: 14,
			reason: "Nested mappings are not allowed in compact mappings",
		});
		expect(JSON.stringify(details)).not.toContain("\\n");
	});

	it("keeps the parser reason for errors without a source snippet", () => {
		expect(describeFrontmatterError(new Error("boom"))).toEqual({
			line: undefined,
			column: undefined,
			reason: "boom",
		});
		expect(describeFrontmatterError("nope")).toEqual({ line: undefined, column: undefined, reason: "nope" });
	});

	it("formats a single-line message that names the file, location, reason and fix", () => {
		expect(formatFrontmatterError("/skills/search-first/SKILL.md", captureError(unquotedColon), unquotedColon)).toBe(
			'/skills/search-first/SKILL.md: invalid YAML frontmatter at line 3, column 14: Nested mappings are not allowed in compact mappings — description contains an unquoted ":" — wrap the value in double quotes',
		);
	});

	it("omits the colon hint for unrelated YAML errors", () => {
		const broken = "---\nname: broken\ndescription: [unclosed\n---\nBody";
		const message = formatFrontmatterError("/skills/broken/SKILL.md", captureError(broken), broken);

		expect(message).toBe(
			"/skills/broken/SKILL.md: invalid YAML frontmatter at line 3, column 23: " +
				"Flow sequence in block collection must be sufficiently indented and end with a ]",
		);
	});

	it("omits the location when the parser does not report one", () => {
		expect(formatFrontmatterError("/skills/broken/SKILL.md", new Error("boom"), unquotedColon)).toBe(
			"/skills/broken/SKILL.md: invalid YAML frontmatter: boom — " +
				'description contains an unquoted ":" — wrap the value in double quotes',
		);
	});

	it.each([null, undefined])("handles an absent error (%s)", (error) => {
		expect(() => describeFrontmatterError(error)).not.toThrow();
	});

	it("escapes control characters in parser reasons", () => {
		const broken = '---\ndescription: "bad\\\u001b[31m"\n---';
		const message = formatFrontmatterError("/skills/broken/SKILL.md", captureError(broken), broken);
		expect(message).not.toContain("\u001b");
		expect(message).toContain("\\u001b");
	});

	it.each([
		"description: # note: later\nother: [unclosed",
		"description: |\n  description: harmless: text\nother: [unclosed",
		"notes: |\n  description: harmless: text\ndescription: valid\nother: [unclosed",
	])("does not recommend quoting valid descriptions: %s", (yaml) => {
		const broken = `---\n${yaml}\n---`;
		expect(hasUnquotedColonInDescription(broken)).toBe(false);
		expect(formatFrontmatterError("/skills/broken/SKILL.md", captureError(broken), broken)).not.toContain(
			"wrap the value",
		);
	});

	it.each(["\n", "\r\n", "\r"])("preserves file-relative coordinates with %j line endings", (newline) => {
		const broken = `\uFEFF${unquotedColon.replaceAll("\n", newline)}`;
		expect(describeFrontmatterError(captureError(broken))).toMatchObject({ line: 3, column: 14 });
	});

	describe("hasUnquotedColonInDescription", () => {
		it("detects an unquoted colon in the description value", () => {
			expect(hasUnquotedColonInDescription(unquotedColon)).toBe(true);
		});

		it("detects an unquoted colon on a continued description line", () => {
			const content =
				"---\nname: x\ndescription: Enforce a claim-to-proof workflow\n  define the evidence: then require it\n---\nBody";
			expect(hasUnquotedColonInDescription(content)).toBe(true);
		});

		it("accepts quoted, block and flow-safe descriptions", () => {
			expect(hasUnquotedColonInDescription('---\ndescription: "Enforce a claim: to proof"\n---\n')).toBe(false);
			expect(hasUnquotedColonInDescription("---\ndescription: 'Enforce a claim: to proof'\n---\n")).toBe(false);
			expect(hasUnquotedColonInDescription("---\ndescription: |\n  Enforce a claim: to proof\n---\n")).toBe(false);
			expect(hasUnquotedColonInDescription("---\ndescription: Enforce a claim-to-proof workflow\n---\n")).toBe(
				false,
			);
			expect(hasUnquotedColonInDescription("---\ndescription: Runs at 10:30 daily\n---\n")).toBe(false);
			expect(hasUnquotedColonInDescription("---\ndescription: See https://example.com/x\n---\n")).toBe(false);
			expect(hasUnquotedColonInDescription("---\ndescription: Enforce a claim # note: later\n---\n")).toBe(false);
			expect(hasUnquotedColonInDescription("# no frontmatter: at all")).toBe(false);
		});
	});
});

describe("stripFrontmatter", () => {
	it("removes frontmatter and trims body", () => {
		const input = "---\nkey: value\n---\n\nBody\n";
		expect(stripFrontmatter(input)).toBe("Body");
	});

	it("returns body when no frontmatter present", () => {
		const input = "\n  No frontmatter body  \n";
		expect(stripFrontmatter(input)).toBe("\n  No frontmatter body  \n");
	});
});
