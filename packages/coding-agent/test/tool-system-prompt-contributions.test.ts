import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { bashToolSystemPromptContribution, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition, editToolSystemPromptContribution } from "../src/core/tools/edit.ts";
import { createFindToolDefinition, findToolSystemPromptContribution } from "../src/core/tools/find.ts";
import { createGrepToolDefinition, grepToolSystemPromptContribution } from "../src/core/tools/grep.ts";
import { createLsToolDefinition, lsToolSystemPromptContribution } from "../src/core/tools/ls.ts";
import {
	createPowerShellToolDefinition,
	powershellToolSystemPromptContribution,
} from "../src/core/tools/powershell.ts";
import { createReadToolDefinition, readToolSystemPromptContribution } from "../src/core/tools/read.ts";
import { createWriteToolDefinition, writeToolSystemPromptContribution } from "../src/core/tools/write.ts";
import { buildStepSystemPromptAppendix } from "../src/step/system-prompt.ts";
import { createStepToolProfile } from "../src/step/tool-profile.ts";

const cases = [
	["read", readToolSystemPromptContribution, createReadToolDefinition],
	["bash", bashToolSystemPromptContribution, createBashToolDefinition],
	["powershell", powershellToolSystemPromptContribution, createPowerShellToolDefinition],
	["edit", editToolSystemPromptContribution, createEditToolDefinition],
	["write", writeToolSystemPromptContribution, createWriteToolDefinition],
	["grep", grepToolSystemPromptContribution, createGrepToolDefinition],
	["find", findToolSystemPromptContribution, createFindToolDefinition],
	["ls", lsToolSystemPromptContribution, createLsToolDefinition],
] as const;

describe("built-in tool system prompt contributions", () => {
	test.each(cases)(
		"keeps the %s tool definition aligned with its contribution",
		(_name, contribution, createDefinition) => {
			const definition = createDefinition("/workspace");

			expect(definition.promptSnippet).toBe(contribution.snippet);
			expect(definition.promptGuidelines ?? []).toEqual(contribution.guidelines);
		},
	);

	test.each([
		["bash", createBashToolDefinition],
		["powershell", createPowerShellToolDefinition],
	] as const)("does not advertise removed %s session environment variables", (_name, createDefinition) => {
		const definition = createDefinition("/workspace");

		expect(definition.promptGuidelines ?? []).toEqual([]);
	});

	test("keeps Step descriptions functional without shell precedence claims", () => {
		const tools = createStepToolProfile("/workspace");
		for (const name of ["list_directory", "find_files", "search_files", "read_file", "run_command"]) {
			const tool = tools.find((definition) => definition.name === name);
			expect(tool).toBeDefined();
			expect(tool?.description).not.toMatch(/prefer.*(?:shell|dedicated)|token efficiency/i);
		}
		const command = tools.find((tool) => tool.name === "run_command");
		expect(command?.description).toBe(
			"Run a non-interactive shell command. Foreground calls return combined stdout/stderr; run_in_background=true returns a pid and log path. Uses cwd when supplied, otherwise the initial working directory.",
		);
		expect(command?.parameters.properties.command.description).toBe("Shell command to execute.");
		expect(command?.parameters.properties.max_output_chars.description).toContain(
			"combined stdout/stderr characters, not tokens",
		);
		const read = tools.find((tool) => tool.name === "read_file");
		expect(read?.parameters.properties.max_chars.description).toContain("text characters, not tokens");
		const edit = tools.find((tool) => tool.name === "edit_file");
		expect(edit?.description).toContain("without displayed line prefixes");
		expect(edit?.description).toContain("appear exactly once unless replace_all is true");
		expect(edit?.description).toContain("If no match is found, inspect current content; if ambiguous, add context");
		expect(edit?.description).not.toMatch(/fuzzy/i);
		expect(tools.find((tool) => tool.name === "write_file")?.description).toContain("complete content");
		expect(tools.find((tool) => tool.name === "find_tools")?.description).toContain("exact names and schemas");
	});

	test("composes Step tool snippets and guidelines into the model-facing prompt", () => {
		const tools = createStepToolProfile("/workspace");
		const prompt = buildSystemPrompt({
			selectedTools: tools.map((tool) => tool.name),
			toolSnippets: Object.fromEntries(tools.map((tool) => [tool.name, tool.promptSnippet ?? ""])),
			promptGuidelines: tools.flatMap((tool) => tool.promptGuidelines ?? []),
			contextFiles: [],
			skills: [],
			cwd: "/workspace",
			product: {
				name: "StepCode",
				includeDocumentation: false,
				promptAppendix: buildStepSystemPromptAppendix,
			},
		});
		expect(prompt).toContain("- run_command: Run a non-interactive shell command");
		expect(prompt).toContain("Use edit_file for precise literal changes against current file content");
		expect(prompt).toContain("shell pipelines or read-only scripts better express the task");
		expect(prompt).toContain("Example run_command arguments:");
		expect(prompt).not.toContain("Prefer dedicated StepCode tools over shell equivalents");
	});
});
