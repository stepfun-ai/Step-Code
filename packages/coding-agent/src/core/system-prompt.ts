/**
 * System prompt construction and project context loading
 */

import { APP_NAME, getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Product-facing identity for entrypoints layered on top of pi. */
	product?: SystemPromptProduct;
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

export interface SystemPromptProduct {
	/** Name shown to the model in the default prompt. */
	name: string;
	/** Optional role phrase following the product name. A leading "Name, " is accepted for compatibility. */
	role?: string;
	/** Full opening identity sentence/paragraph for product-specific prompts. */
	introduction?: string;
	/** Whether to include pi's documentation discovery section. Defaults to true. */
	includeDocumentation?: boolean;
	/** Product-specific guidance appended after loaded project context. */
	promptAppendix?: string | ((activeToolNames: readonly string[], context: SystemPromptProductContext) => string);
}

export interface SystemPromptProductContext {
	/** Normalized initial working directory. */
	cwd: string;
	/** Node's runtime platform identifier. */
	platform: string;
	/** Local calendar date at prompt construction time (YYYY-MM-DD). */
	date: string;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		product,
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const productName = product?.name?.trim() || APP_NAME;
	const suppliedRole = product?.role?.trim();
	// Keep the sentence grammatically stable for both forms accepted by the
	// public adapter: "an interactive ..." and the older "Step, an interactive ...".
	const productRole =
		suppliedRole?.replace(new RegExp(`^${escapeRegExp(productName)}\\s*,\\s*`, "iu"), "").trim() ||
		"a coding agent harness";
	const introduction =
		product?.introduction?.trim() ||
		`You are an expert coding assistant operating inside ${productName}, ${productRole}. You help users by reading files, executing commands, editing code, and writing new files.`;
	const promptCwd = cwd.replace(/\\/g, "/");
	const activeToolNames = selectedTools ?? ["read", "bash", "edit", "write"];
	const productContext: SystemPromptProductContext = {
		cwd: promptCwd,
		platform: process.platform,
		date: new Date().toISOString().slice(0, 10),
	};
	const productAppendixValue =
		typeof product?.promptAppendix === "function"
			? product.promptAppendix(activeToolNames, productContext)
			: product?.promptAppendix;
	const productAppendix = productAppendixValue?.trim() ? `\n\n${productAppendixValue.trim()}` : "";

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead =
			!selectedTools || selectedTools.some((name) => name === "read" || name === "read_file");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}
		if (productAppendix) {
			prompt += productAppendix;
		}

		prompt += `\nCurrent working directory: ${promptCwd}\n`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = activeToolNames;
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash") || tools.includes("run_command");
	const hasPowerShell = tools.includes("powershell");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read") || tools.includes("read_file");

	// File exploration guidelines
	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addGuideline("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addGuideline("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addGuideline("Use bash for file operations like ls, rg, find");
		}
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `${introduction}

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

${
	product?.includeDocumentation === false
		? ""
		: `${productName} documentation (read only when the user asks about ${productName} itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading ${APP_NAME} docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), ${productName} packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on ${productName} topics, read the docs and examples, and follow .md cross-references before implementing
- Always read ${productName} .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`
}`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}
	if (productAppendix) {
		prompt += productAppendix;
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
