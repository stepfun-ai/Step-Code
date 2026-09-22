/**
 * Agent definitions used by Step's native subagent extension.
 *
 * Pi's example keeps this discovery helper next to the extension. Step uses
 * the same frontmatter shape, but resolves the product-owned directories
 * through the Step namespace (`.stepcode`) instead of Pi's `.pi` paths.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";

export type StepAgentScope = "user" | "project" | "both";
export type StepAgentSource = "builtin" | "user" | "project";

export interface StepAgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: StepAgentSource;
	/** Undefined for an embedded built-in definition. */
	filePath?: string;
}

export interface StepAgentDiscoveryResult {
	agents: StepAgentConfig[];
	userAgentsDir: string;
	projectAgentsDir: string | null;
}

export interface StepAgentDiscoveryOptions {
	/** Global Step agent root (`~/.stepcode/agent` by default). */
	agentDir?: string;
	/** Project resource directory (`.stepcode` by default). */
	configDirName?: string;
	/** Resource scopes to include. Defaults to both global and project files. */
	scope?: StepAgentScope;
	/** Include the four safe, built-in role definitions. */
	includeBuiltin?: boolean;
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
};

/** Built-ins make the feature useful on a fresh Step install. User files with
 * the same name override these definitions, then project files override user
 * files when both scopes are selected. */
const BUILTIN_AGENTS: readonly StepAgentConfig[] = [
	{
		name: "general",
		description: "Implementation and edits; full tool access, including file writes",
		tools: undefined,
		systemPrompt: "Work independently on the delegated task and return a concise, verifiable result.",
		source: "builtin",
	},
	{
		name: "explore",
		description: "Read-only exploration and codebase reconnaissance; cannot edit files or run commands",
		tools: ["read_file", "find_files", "search_files", "list_directory"],
		systemPrompt:
			"Explore the repository carefully. Do not modify files. Return precise findings and relevant paths.",
		source: "builtin",
	},
	{
		name: "review",
		description: "Read-only review for correctness, regressions, and missing tests; can run commands",
		tools: ["read_file", "find_files", "search_files", "list_directory", "run_command"],
		systemPrompt:
			"Review the requested change rigorously. Do not modify files; report concrete findings with file references.",
		source: "builtin",
	},
	{
		name: "planner",
		description: "Read-only analysis producing an implementation plan; can run commands",
		tools: ["read_file", "find_files", "search_files", "list_directory", "run_command"],
		systemPrompt: "Analyze the task and repository, then return a focused implementation plan. Do not modify files.",
		source: "builtin",
	},
];

/**
 * Models often reach for a descriptive form ("general-purpose") rather than the
 * exact built-in name. Keep those forms as aliases while retaining exact
 * matching for user- and project-defined names.
 */
const BUILTIN_AGENT_ALIASES: ReadonlyMap<string, string> = new Map([
	["general-purpose", "general"],
	["general purpose", "general"],
	["general_purpose", "general"],
]);

function parseToolList(value: unknown): string[] | undefined {
	const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = values
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return tools.length > 0 ? tools : undefined;
}

async function isDirectory(directory: string): Promise<boolean> {
	try {
		return (await stat(directory)).isDirectory();
	} catch {
		return false;
	}
}

async function loadAgentsFromDirectory(directory: string, source: "user" | "project"): Promise<StepAgentConfig[]> {
	let entries: Dirent<string>[];
	try {
		entries = await readdir(directory, { encoding: "utf8", withFileTypes: true });
	} catch {
		return [];
	}

	const agents: StepAgentConfig[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = path.join(directory, entry.name);
		let content: string;
		try {
			content = await readFile(filePath, "utf8");
		} catch {
			continue;
		}

		let parsed: ReturnType<typeof parseFrontmatter<AgentFrontmatter>>;
		try {
			parsed = parseFrontmatter<AgentFrontmatter>(content);
		} catch {
			// A malformed definition must not hide the remaining agents.
			continue;
		}
		if (typeof parsed.frontmatter.name !== "string" || typeof parsed.frontmatter.description !== "string") continue;

		agents.push({
			name: parsed.frontmatter.name.trim(),
			description: parsed.frontmatter.description.trim(),
			tools: parseToolList(parsed.frontmatter.tools),
			model: typeof parsed.frontmatter.model === "string" ? parsed.frontmatter.model.trim() || undefined : undefined,
			systemPrompt: parsed.body,
			source,
			filePath,
		});
	}
	return agents.filter((agent) => agent.name.length > 0 && agent.description.length > 0);
}

async function findNearestProjectAgentsDir(cwd: string, configDirName: string): Promise<string | null> {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, configDirName, "agents");
		if (await isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/** Discover built-in, global, and nearest project-local Step definitions. */
export async function discoverStepAgents(
	cwd: string,
	options: StepAgentDiscoveryOptions = {},
): Promise<StepAgentDiscoveryResult> {
	const agentDir = path.resolve(options.agentDir ?? getAgentDir());
	const configDirName = options.configDirName?.trim() || CONFIG_DIR_NAME;
	const userAgentsDir = path.join(agentDir, "agents");
	const projectAgentsDir = await findNearestProjectAgentsDir(cwd, configDirName);
	const includeBuiltin = options.includeBuiltin !== false;

	const definitions: StepAgentConfig[] = [];
	if (includeBuiltin) definitions.push(...BUILTIN_AGENTS);
	// User and project files remain independently discoverable even when the
	// caller later filters by scope.
	definitions.push(...(await loadAgentsFromDirectory(userAgentsDir, "user")));
	if (projectAgentsDir) definitions.push(...(await loadAgentsFromDirectory(projectAgentsDir, "project")));

	const scope = options.scope ?? "both";
	const visible = definitions.filter(
		(agent) => agent.source === "builtin" || scope === "both" || scope === agent.source,
	);
	const byName = new Map<string, StepAgentConfig>();
	for (const agent of visible) {
		// Iteration order encodes precedence: built-in < user < project.
		byName.set(agent.name, agent);
	}

	return { agents: [...byName.values()], userAgentsDir, projectAgentsDir };
}

/**
 * Built-in agent guidance for the `subagent` tool description.
 *
 * Derived from BUILTIN_AGENTS so the tool description cannot drift from the
 * catalog, and capability-annotated because agent choice happens before any
 * catalog is shown: `formatStepAgentCatalog` is only reached on the
 * unknown-agent error path, so a caller picking an agent otherwise sees four
 * bare names and no access levels, and defaults to "general" for work that
 * should have been read-only.
 */
export function formatBuiltinAgentGuidance(): string {
	const listed = BUILTIN_AGENTS.map((agent) => `"${agent.name}" (${agent.description})`).join(", ");
	return [
		`Built-in agents, by exact name: ${listed}.`,
		"Pass the quoted name only; the parenthetical is a capability note, never a name.",
		'Prefer a read-only agent for review, audit, or exploration work; "general" is the only built-in that can modify files.',
	].join(" ");
}

export function formatStepAgentCatalog(agents: readonly StepAgentConfig[], maxItems = 8): string {
	if (agents.length === 0) return "none";
	// Pipe-separated: descriptions carry their own semicolons and commas, so a
	// "; " joiner made entry boundaries ambiguous in the unknown-agent error.
	const listed = agents.slice(0, maxItems).map((agent) => `${agent.name} (${agent.source}): ${agent.description}`);
	const suffix = agents.length > maxItems ? ` | ... +${agents.length - maxItems} more` : "";
	return `${listed.join(" | ")}${suffix}`;
}

/** Resolve an exact agent name, then a compatibility alias for a built-in. */
export function resolveStepAgent(
	agents: readonly StepAgentConfig[],
	requestedName: string,
): StepAgentConfig | undefined {
	const exact = agents.find((agent) => agent.name === requestedName);
	if (exact) return exact;
	const canonicalName = BUILTIN_AGENT_ALIASES.get(requestedName.trim().toLowerCase());
	return canonicalName ? agents.find((agent) => agent.name === canonicalName) : undefined;
}

export const builtinStepAgents: readonly StepAgentConfig[] = BUILTIN_AGENTS;
