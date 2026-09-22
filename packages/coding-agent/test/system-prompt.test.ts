import { describe, expect, test } from "vitest";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test.each([
			[["powershell"], "Use PowerShell for file operations"],
			[["bash", "powershell"], "Use bash or PowerShell for file operations"],
		] as const)("uses shell-specific guidance for %j", (selectedTools, expected) => {
			const prompt = buildSystemPrompt({
				selectedTools: [...selectedTools],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(expected);
		});

		test("instructs models to resolve Step docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading step docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
			expect(prompt).toContain("environment variables (docs/environment-variables.md)");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("product identity", () => {
		const base = {
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		};

		test("renders a product role without duplicating the product name", () => {
			const prompt = buildSystemPrompt({
				...base,
				product: { name: "Step", role: "an interactive terminal coding agent" },
			});

			expect(prompt).toContain("operating inside Step, an interactive terminal coding agent.");
			expect(prompt).not.toContain("inside Step, Step,");
		});

		test("accepts a legacy role that already starts with the product name", () => {
			const prompt = buildSystemPrompt({
				...base,
				product: {
					name: "Step",
					role: "Step, an interactive terminal coding agent",
				},
			});

			expect(prompt).toContain("operating inside Step, an interactive terminal coding agent.");
		});

		test("allows a product to provide the exact opening identity and hide runtime docs", () => {
			const prompt = buildSystemPrompt({
				...base,
				product: {
					name: "StepCode",
					introduction: "You are StepCode, an interactive terminal coding agent developed by StepFun.",
					includeDocumentation: false,
				},
			});

			expect(prompt.startsWith("You are StepCode, an interactive terminal coding agent developed by StepFun.")).toBe(
				true,
			);
			expect(prompt).not.toContain("documentation (read only");
		});

		test("appends product guidance after project context and skills", () => {
			const prompt = buildSystemPrompt({
				...base,
				product: {
					name: "Step",
					promptAppendix: (activeTools) => `Step tools: ${activeTools.join(",")}`,
				},
				selectedTools: ["read", "edit"],
				contextFiles: [{ path: "AGENTS.md", content: "project rules" }],
			});

			expect(prompt).toContain("Step tools: read,edit");
			expect(prompt.indexOf("Step tools: read,edit")).toBeGreaterThan(prompt.indexOf("project rules"));
		});

		test("does not call a product appendix for disabled tools", () => {
			const prompt = buildSystemPrompt({
				...base,
				product: {
					name: "Step",
					promptAppendix: (activeTools) => (activeTools.includes("read") ? "read-enabled" : "read-disabled"),
				},
				selectedTools: ["bash"],
			});

			expect(prompt).toContain("read-disabled");
			expect(prompt).not.toContain("read-enabled");
		});

		test("passes normalized environment context to a product appendix", () => {
			let received: { cwd: string; platform: string; date: string } | undefined;
			buildSystemPrompt({
				...base,
				cwd: "C:\\workspace\\step",
				product: {
					name: "Step",
					promptAppendix: (_tools, context) => {
						received = context;
						return "context-received";
					},
				},
			});

			expect(received).toMatchObject({
				cwd: "C:/workspace/step",
				platform: expect.any(String),
				date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			});
		});
	});

	test("loads skills for a custom prompt when the Step read_file alias is active", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "Custom prompt",
			selectedTools: ["read_file"],
			contextFiles: [],
			skills: [
				{
					name: "review",
					description: "Review guidance",
					filePath: "/tmp/review/SKILL.md",
					baseDir: "/tmp/review",
					sourceInfo: createSyntheticSourceInfo("/tmp/review/SKILL.md", {
						source: "test",
					}),
					disableModelInvocation: false,
				},
			],
			cwd: process.cwd(),
		});

		expect(prompt).toContain("review");
		expect(prompt).toContain("Review guidance");
	});
});
