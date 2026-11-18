import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { parseSkillBlock } from "../src/utils/skill-block.ts";

describe("export HTML skill block rendering", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	it("strips skill wrapper XML from user message rendering", () => {
		// Skill commands store a structural wrapper in the raw user message:
		//   <skill name="..." location="...">\n...\n</skill>\n\nactual prompt
		// The export renderer must detect that wrapper and render only the user-visible prompt,
		// not the Pi-generated <skill>...</skill> XML tags.
		expect(templateJs).toMatch(/parseSkillBlock/);
		expect(templateJs).toMatch(/skillBlock\.userMessage/);
	});

	it("renders skill invocation and user message as separate sibling blocks", () => {
		// The skill block and user message should render as separate entry-level elements,
		// matching the TUI layout where SkillInvocationMessageComponent and
		// UserMessageComponent are siblings, not nested.
		expect(templateJs).toMatch(/skill-invocation/);

		// When a skill block has a userMessage, the user-message div must be emitted
		// as a separate block after the skill-invocation div, containing the user-authored text.
		// Verify the code checks hasUserContent so the user-message div is only omitted
		// when the skill block has no user prompt and no images.
		expect(templateJs).toMatch(/hasUserContent/);
	});

	it("renders skill content as markdown, not raw text", () => {
		// The skill block body is markdown (from the SKILL.md file).
		// It should be rendered through safeMarkedParse, not escaped as raw text.
		expect(templateJs).toMatch(/safeMarkedParse\(skillBlock\.content\)/);
	});

	it("shows skill name and user message in the sidebar tree", () => {
		// The sidebar tree should display both the skill name and the user prompt,
		// not just one or the other.
		expect(templateJs).toMatch(/tree-role-skill/);
	});

	it("parses skill blocks exactly like the shared parser", () => {
		const source = templateJs.match(/function parseSkillBlock\(text\) \{[\s\S]*?\n {6}\}\n/)?.[0];
		expect(source).toBeDefined();
		const parseInTemplate = new Function(`${source}\nreturn parseSkillBlock;`)() as typeof parseSkillBlock;
		for (const text of [
			'<skill name="literal" location="/skills/a&amp;b.md">\nKeep &lt;tag&gt; text.\n</skill>\n\nprompt',
			'<skill name="encoded" location="/skills/a&amp;b.md" encoding="xml">\nKeep &amp;lt;tag&amp;gt; &quot;q&quot;.\n</skill>\n\n<skill name="next" location="/n" encoding="xml">\nNext\n</skill>\n\ntask',
			"plain text",
		]) {
			expect(parseInTemplate(text)).toEqual(parseSkillBlock(text));
		}
	});
});
