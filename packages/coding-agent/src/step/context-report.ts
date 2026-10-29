import type { AgentMessage } from "@step-harness/agent-core";
import type { Api, ImageContent, Model, TextContent } from "@step-harness/providers";
import type { ExtensionCommandContext, ToolInfo } from "../core/extensions/types.ts";
import { sessionEntryToContextMessages } from "../core/session-manager.ts";
import { formatSkillForPrompt, formatSkillsForPrompt } from "../core/skills.ts";
import type { BuildSystemPromptOptions } from "../core/system-prompt.ts";
import { getStepMcpStatuses } from "./mcp.ts";
import {
	countStepTokens,
	resolveStepTokenCountModel,
	type StepTokenCountApi,
	type StepTokenCountRequest,
	supportsStepTokenCount,
} from "./token-count.ts";

export interface ContextReportRow {
	id: string;
	label: string;
	tokens: number | null;
	detail?: string;
	children?: ContextReportRow[];
}

export interface ContextReport {
	contextWindow: number;
	usedTokens: number | null;
	percent: number | null;
	reserveTokens?: number;
	freeTokens: number | null;
	groups: ContextReportRow[];
	/** Where the displayed totals come from when the host can count tokens. */
	tokenSource: "estimate" | "provider";
}

export type ContextGroupId = "instructions" | "tools" | "conversation";

export interface ContextTokenCounts {
	groups?: Partial<Record<ContextGroupId, number | null>>;
	rows?: Record<string, number | null>;
}

export interface ContextReportInput {
	systemPrompt: string;
	systemPromptOptions: BuildSystemPromptOptions;
	tools?: readonly ToolInfo[];
	mcpServerNames?: readonly string[];
	messages: readonly AgentMessage[];
	contextWindow: number;
	reserveTokens?: number;
	/** Host-reported current context tokens when available; anchors the estimated breakdown. */
	reportedTokens?: number | null;
	/** Provider tokenizer counts for the report's structural segments. */
	tokenCounts?: ContextTokenCounts;
}

export type ContextMeterSegment = "instructions" | "tools" | "conversation" | "reserve" | "free";

/**
 * Estimate text tokens by code-point class. ASCII is roughly four characters per
 * token; CJK, full-width, and emoji are closer to one token per code point. This
 * is still an estimate, but it avoids the worst failure of a flat chars/4 rule on
 * Chinese prompts and tool output.
 */
function estimateText(text: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (const character of text) {
		if ((character.codePointAt(0) ?? 0) < 128) ascii += 1;
		else nonAscii += 1;
	}
	return Math.ceil(ascii / 4) + nonAscii;
}

function estimateJson(value: unknown): number {
	return estimateText(JSON.stringify(value) ?? "");
}

/** Image blocks are not tokenized from base64; they are counted as a fixed block. */
const ESTIMATED_IMAGE_TOKENS = 1500;

function estimateAgentMessage(message: AgentMessage): number {
	switch (message.role) {
		case "user": {
			if (typeof message.content === "string") return estimateText(message.content);
			let tokens = 0;
			for (const block of message.content) {
				if (block.type === "text") tokens += estimateText(block.text);
				else if (block.type === "image") tokens += ESTIMATED_IMAGE_TOKENS;
				else tokens += estimateJson(block);
			}
			return tokens;
		}
		case "assistant": {
			let tokens = 0;
			for (const block of message.content) {
				if (block.type === "text") tokens += estimateText(block.text);
				else if (block.type === "thinking") tokens += estimateText(block.thinking);
				else if (block.type === "toolCall") tokens += estimateText(block.name) + estimateJson(block.arguments);
				else tokens += estimateJson(block);
			}
			return tokens;
		}
		case "toolResult": {
			let tokens = 0;
			for (const block of message.content) {
				if (block.type === "text") tokens += estimateText(block.text);
				else if (block.type === "image") tokens += ESTIMATED_IMAGE_TOKENS;
				else tokens += estimateJson(block);
			}
			return tokens;
		}
		case "bashExecution":
			return estimateText(message.command) + estimateText(message.output);
		case "branchSummary":
		case "compactionSummary":
			return estimateText(message.summary);
		case "custom":
			return typeof message.content === "string" ? estimateText(message.content) : estimateJson(message.content);
		default:
			return estimateJson(message);
	}
}

function sumRows(rows: readonly ContextReportRow[]): number | null {
	let total = 0;
	for (const row of rows) {
		if (row.tokens === null) return null;
		total += row.tokens;
	}
	return total;
}

function nonZero(row: ContextReportRow): boolean {
	return row.tokens === null || row.tokens > 0 || (row.children?.length ?? 0) > 0;
}

function toolKind(tool: ToolInfo, mcpServerNames: readonly string[]): "builtin" | "mcp" | "extension" | "sdk" {
	if (mcpServerNames.some((name) => tool.name === name || tool.name.startsWith(`${name}__`))) return "mcp";
	const source = tool.sourceInfo.source;
	const sourcePath = tool.sourceInfo.path ?? "";
	if (source === "sdk" || sourcePath.startsWith("<sdk:")) return "sdk";
	if (source === "builtin" || sourcePath.startsWith("<builtin:")) return "builtin";
	return "extension";
}

function toolRows(input: ContextReportInput): ContextReportRow[] {
	if (!input.tools) return [{ id: "tools", label: "Tool definitions", tokens: null }];
	const groups: Record<"builtin" | "mcp" | "extension" | "sdk", ContextReportRow[]> = {
		builtin: [],
		mcp: [],
		extension: [],
		sdk: [],
	};
	for (const tool of input.tools) {
		const serialized = JSON.stringify({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		});
		groups[toolKind(tool, input.mcpServerNames ?? [])].push({
			id: `tool:${tool.name}`,
			label: tool.name,
			tokens: estimateText(serialized),
			detail: tool.sourceInfo.path,
		});
	}
	const definitions = [
		{ id: "builtin-tools", label: "Built-in tools", rows: groups.builtin },
		{ id: "mcp-tools", label: "MCP tools", rows: groups.mcp },
		{ id: "extension-tools", label: "Extensions & SDK", rows: groups.extension },
		{ id: "sdk-tools", label: "SDK tools", rows: groups.sdk },
	];
	return definitions.map(({ id, label, rows }) => ({
		id,
		label,
		tokens: sumRows(rows) ?? 0,
		children: rows.sort((a, b) => b.tokens! - a.tokens! || a.label.localeCompare(b.label)),
	}));
}

function instructionRows(input: ContextReportInput): ContextReportRow[] {
	const options = input.systemPromptOptions;
	const activeTools = options.selectedTools ?? ["read", "bash", "edit", "write"];
	const readTool = activeTools.includes("read") ? "read" : activeTools.includes("read_file") ? "read_file" : undefined;
	const skills = options.skills ?? [];
	const visibleSkills = readTool ? skills.filter((skill) => !skill.disableModelInvocation) : [];
	const skillsSection = readTool ? formatSkillsForPrompt(visibleSkills, readTool) : "";
	const skillsTokens =
		skillsSection.length > 0 && input.systemPrompt.includes(skillsSection) ? estimateText(skillsSection) : 0;
	const skillCharMap: Record<string, number> = {};
	for (const skill of visibleSkills) {
		skillCharMap[skill.filePath] = formatSkillForPrompt(skill).length;
	}
	const skillTokenMap = skillsTokens > 0 ? allocateTokenCounts(skillCharMap, skillsTokens) : {};
	const skillRows = visibleSkills.map((skill) => ({
		id: `skill:${skill.filePath}`,
		label: skill.name,
		tokens: skillTokenMap[skill.filePath] ?? 0,
		detail: skill.filePath,
	}));
	const contextFiles = options.contextFiles ?? [];
	const contextBlocks = contextFiles.map(
		(file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`,
	);
	const contextSection =
		contextBlocks.length > 0
			? `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${contextBlocks.join("")}</project_context>\n`
			: "";
	const contextFilesTokens =
		contextSection.length > 0 && input.systemPrompt.includes(contextSection) ? estimateText(contextSection) : 0;
	const contextCharMap: Record<string, number> = {};
	for (const [index, file] of contextFiles.entries()) {
		contextCharMap[file.path] = contextBlocks[index]?.length ?? 0;
	}
	const contextTokenMap = contextFilesTokens > 0 ? allocateTokenCounts(contextCharMap, contextFilesTokens) : {};
	const contextFileRows = contextFiles.map((file) => ({
		id: `context-file:${file.path}`,
		label: file.path.split(/[\\/]/u).at(-1) || file.path,
		tokens: contextTokenMap[file.path] ?? 0,
		detail: file.path,
	}));
	const systemTokens = estimateText(input.systemPrompt);
	// Each section is rounded independently, so their estimates can sum to one
	// token more than the whole prompt when there is no base text between them.
	const baseTokens = Math.max(0, systemTokens - skillsTokens - contextFilesTokens);
	return [
		{ id: "system-prompt", label: "System prompt & dynamic", tokens: baseTokens },
		...(skills.length
			? [{ id: "skills", label: `Skills (${skills.length})`, tokens: skillsTokens, children: skillRows }]
			: []),
		...(contextFileRows.length
			? [
					{
						id: "project-context",
						label: `AGENTS.md & memory (${contextFileRows.length})`,
						tokens: contextFilesTokens,
						children: contextFileRows,
					},
				]
			: []),
	];
}

function allocateTokenCounts<T extends string>(chars: Record<T, number>, total: number): Record<T, number> {
	const entries = Object.entries(chars) as [T, number][];
	const result = Object.fromEntries(entries.map(([id, charCount]) => [id, Math.floor(charCount / 4)])) as Record<
		T,
		number
	>;
	let remaining = total - entries.reduce((sum, [id]) => sum + result[id], 0);
	const order = entries
		.map(([id, charCount], index) => ({ id, index, remainder: charCount % 4 }))
		.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
	for (let index = 0; remaining > 0 && order.length > 0; index = (index + 1) % order.length) {
		result[order[index].id] += 1;
		remaining -= 1;
	}
	return result;
}

function messageRows(messages: readonly AgentMessage[]): ContextReportRow[] {
	const tokens: Record<string, number> = {
		user: 0,
		assistant: 0,
		thinking: 0,
		toolCalls: 0,
		toolResults: 0,
		compaction: 0,
		injected: 0,
		other: 0,
	};
	for (const message of messages) {
		switch (message.role) {
			case "user":
				tokens.user += estimateAgentMessage(message);
				break;
			case "assistant": {
				const weights = { assistant: 0, thinking: 0, toolCalls: 0 };
				for (const block of message.content) {
					if (block.type === "text") weights.assistant += estimateText(block.text);
					else if (block.type === "thinking") weights.thinking += estimateText(block.thinking);
					else if (block.type === "toolCall") {
						weights.toolCalls += estimateText(block.name) + estimateJson(block.arguments);
					} else weights.assistant += estimateJson(block);
				}
				tokens.assistant += weights.assistant;
				tokens.thinking += weights.thinking;
				tokens.toolCalls += weights.toolCalls;
				break;
			}
			case "toolResult":
				tokens.toolResults += estimateAgentMessage(message);
				break;
			case "bashExecution": {
				tokens.toolCalls += estimateText(message.command);
				tokens.toolResults += estimateText(message.output);
				break;
			}
			case "branchSummary":
			case "compactionSummary":
				tokens.compaction += estimateAgentMessage(message);
				break;
			case "custom":
				tokens.injected += estimateAgentMessage(message);
				break;
			default:
				tokens.other += estimateAgentMessage(message);
		}
	}
	const definitions = [
		["user", "User input"],
		["assistant", "AI answers"],
		["thinking", "Thinking"],
		["toolCalls", "Tool calls"],
		["toolResults", "Tool output"],
		["compaction", "Compaction summaries"],
		["injected", "Injected context"],
		["other", "Other messages"],
	] as const;
	return definitions.map(([id, label]) => ({ id, label, tokens: tokens[id] }));
}

function scaleRows(rows: readonly ContextReportRow[], factor: number): ContextReportRow[] {
	if (factor === 1) return [...rows];
	return rows.map((row) => {
		if (row.children?.length) {
			const children = scaleRows(row.children, factor);
			const tokens = sumRows(children) ?? (row.tokens === null ? null : Math.round(row.tokens * factor));
			return { ...row, tokens, children };
		}
		return { ...row, tokens: row.tokens === null ? null : Math.round(row.tokens * factor) };
	});
}

const CONVERSATION_CATEGORY_IDS = [
	"user",
	"assistant",
	"thinking",
	"toolCalls",
	"toolResults",
	"compaction",
	"injected",
	"other",
] as const;

type ConversationCategoryId = (typeof CONVERSATION_CATEGORY_IDS)[number];

export interface ContextTokenCountSegment {
	id: string;
	request: StepTokenCountRequest;
}

function serializeToolDefinitions(tools: readonly ToolInfo[]): unknown[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

function toolDefinitionsAsJson(tools: readonly ToolInfo[]): string {
	return JSON.stringify(
		tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	);
}

function textBlocksToOpenAiContent(content: string | readonly (TextContent | ImageContent)[]): unknown {
	if (typeof content === "string") return content;
	const parts: unknown[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push({ type: "text", text: block.text });
		else if (block.type === "image") {
			parts.push({ type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
		}
	}
	if (parts.length === 1 && (parts[0] as { type?: string }).type === "text") {
		return (parts[0] as { text: string }).text;
	}
	return parts;
}

function assistantBlockText(content: AssistantMessageLike["content"], type: "text" | "thinking" | "toolCall"): string {
	const parts: string[] = [];
	for (const block of content) {
		if (type === "toolCall" && block.type === "toolCall") {
			parts.push(JSON.stringify({ name: block.name, arguments: block.arguments }));
		} else if (type === "thinking" && block.type === "thinking") {
			parts.push(block.thinking);
		} else if (type === "text" && block.type === "text") {
			parts.push(block.text);
		}
	}
	return parts.join("\n\n");
}

type AssistantMessageLike = Extract<AgentMessage, { role: "assistant" }>;

function categoryMessages(
	messages: readonly AgentMessage[],
	category: ConversationCategoryId,
	api: StepTokenCountApi,
): unknown[] {
	const result: unknown[] = [];
	const pushText = (role: "user" | "assistant" | "system", text: string) => {
		if (text.length === 0) return;
		result.push({ role, content: text });
	};
	for (const message of messages) {
		switch (category) {
			case "user":
				if (message.role === "user") {
					result.push({ role: "user", content: textBlocksToOpenAiContent(message.content) });
				}
				break;
			case "assistant":
				if (message.role === "assistant") {
					const text = assistantBlockText(message.content, "text");
					if (api === "anthropic-messages") pushText("assistant", text);
					else if (text.length > 0) result.push({ role: "assistant", content: text });
				}
				break;
			case "thinking":
				if (message.role === "assistant") {
					const text = assistantBlockText(message.content, "thinking");
					if (api === "anthropic-messages") pushText("assistant", text);
					else if (text.length > 0) result.push({ role: "assistant", content: text });
				}
				break;
			case "toolCalls":
				if (message.role === "assistant") {
					const text = assistantBlockText(message.content, "toolCall");
					if (api === "anthropic-messages") pushText("assistant", text);
					else if (text.length > 0) result.push({ role: "assistant", content: text });
				}
				break;
			case "toolResults":
				if (message.role === "toolResult") {
					const text = message.content
						.filter((block): block is TextContent => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					if (api === "anthropic-messages") pushText("user", text);
					else if (text.length > 0) result.push({ role: "tool", content: text, tool_call_id: message.toolCallId });
				}
				break;
			case "compaction":
				if (message.role === "compactionSummary" || message.role === "branchSummary") {
					pushText("user", message.summary);
				}
				break;
			case "injected":
				if (message.role === "custom") {
					result.push({ role: "user", content: textBlocksToOpenAiContent(message.content) });
				}
				break;
			case "other":
				if (message.role === "bashExecution") {
					pushText("user", `${message.command}\n${message.output}`);
				} else if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
					pushText("user", JSON.stringify(message));
				}
				break;
		}
	}
	return result;
}

function allConversationMessages(messages: readonly AgentMessage[], api: StepTokenCountApi): unknown[] {
	const result: unknown[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			result.push({ role: "user", content: textBlocksToOpenAiContent(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const text = assistantBlockText(message.content, "text");
			const thinking = assistantBlockText(message.content, "thinking");
			const toolCalls = assistantBlockText(message.content, "toolCall");
			const combined = [text, thinking, toolCalls].filter((part) => part.length > 0).join("\n\n");
			if (combined.length > 0) result.push({ role: "assistant", content: combined });
			continue;
		}
		if (message.role === "toolResult") {
			const text = message.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (text.length > 0) {
				result.push(
					api === "anthropic-messages"
						? { role: "user", content: text }
						: { role: "tool", content: text, tool_call_id: message.toolCallId },
				);
			}
			continue;
		}
		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			result.push({ role: "user", content: message.summary });
			continue;
		}
		if (message.role === "custom") {
			result.push({ role: "user", content: textBlocksToOpenAiContent(message.content) });
			continue;
		}
		result.push({ role: "user", content: JSON.stringify(message) });
	}
	return result;
}

/**
 * Build the segmented token-count requests for one report.
 *
 * The platform token-count endpoint returns a total per request, so the report
 * asks for the three top-level groups, a tool-definition probe, and each
 * conversation category. Structural children are then allocated from these
 * counts instead of being sent as one unbounded request per row.
 */
export function buildContextTokenCountSegments(
	input: ContextReportInput,
	api: StepTokenCountApi,
): ContextTokenCountSegment[] {
	const segments: ContextTokenCountSegment[] = [];
	const tools = input.tools ?? [];
	const systemMessage = (content: string): unknown[] => [{ role: "system", content }];
	const anthropicSystem = (content: string): StepTokenCountRequest =>
		api === "anthropic-messages" ? { messages: [], system: content } : { messages: systemMessage(content) };

	if (input.systemPrompt.length > 0) {
		segments.push({ id: "instructions", request: anthropicSystem(input.systemPrompt) });
	}
	segments.push({ id: "empty", request: { messages: [] } });
	if (tools.length > 0) {
		segments.push({ id: "tools-field", request: { messages: [], tools: serializeToolDefinitions(tools) } });
		segments.push({ id: "tools-json", request: anthropicSystem(toolDefinitionsAsJson(tools)) });
	}
	const conversation = allConversationMessages(input.messages, api);
	if (conversation.length > 0) {
		segments.push({ id: "conversation", request: { messages: conversation } });
		for (const category of CONVERSATION_CATEGORY_IDS) {
			const messages = categoryMessages(input.messages, category, api);
			if (messages.length > 0) segments.push({ id: category, request: { messages } });
		}
	}
	return segments;
}

/** Count the report segments through the Step tokenizer endpoint. */
export async function countContextTokenCounts(options: {
	model: Model<Api>;
	auth: Parameters<typeof countStepTokens>[0]["auth"];
	segments: readonly ContextTokenCountSegment[];
	signal?: AbortSignal;
}): Promise<ContextTokenCounts> {
	if (!supportsStepTokenCount(options.model) || !options.auth.ok) return {};
	if (options.segments.length === 0) return {};
	const entries = await Promise.all(
		options.segments.map(
			async (segment) => [segment.id, await countStepTokens({ ...options, request: segment.request })] as const,
		),
	);
	// Tokenizer counts are all-or-nothing: a partial response would mix exact and
	// estimated totals, so fall back to the local structural estimator instead.
	if (entries.some(([, count]) => count === null)) return {};
	const counts = new Map(entries);
	const empty = counts.get("empty") ?? 0;
	const toolsField = counts.get("tools-field");
	const toolsJson = counts.get("tools-json");
	let toolsTokens: number | null = null;
	if (toolsField !== null && toolsField !== undefined) toolsTokens = Math.max(0, toolsField - empty);
	if ((toolsTokens === null || toolsTokens === 0) && toolsJson !== null && toolsJson !== undefined) {
		const jsonTokens = Math.max(0, toolsJson - empty);
		if (jsonTokens > 0) toolsTokens = jsonTokens;
	}
	const rows: Record<string, number | null> = {};
	for (const category of CONVERSATION_CATEGORY_IDS) {
		const count = counts.get(category);
		if (count !== null && count !== undefined) rows[category] = count;
	}
	const rowSum = CONVERSATION_CATEGORY_IDS.reduce((total, category) => total + (rows[category] ?? 0), 0);
	const groups: ContextTokenCounts["groups"] = {
		instructions: counts.get("instructions") ?? 0,
		tools: toolsTokens ?? 0,
		conversation: counts.get("conversation") ?? rowSum,
	};
	return { groups, rows };
}

function allocateChildrenToTotal(row: ContextReportRow, total: number, weights: readonly number[]): ContextReportRow {
	const children = row.children ?? [];
	if (children.length === 0) return { ...row, tokens: total };
	const weightSum = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
	if (weightSum <= 0) {
		return {
			...row,
			tokens: total,
			children: children.map((child) => ({ ...child, tokens: 0 })),
		};
	}
	const factor = total / weightSum;
	const scaledChildren = children.map((child, index) => ({
		...child,
		tokens: Math.round(Math.max(0, weights[index] ?? 0) * factor),
	}));
	const sum = sumRows(scaledChildren) ?? 0;
	const difference = total - sum;
	if (difference !== 0) {
		let targetIndex = -1;
		let maxTokens = -1;
		scaledChildren.forEach((child, index) => {
			if ((child.tokens ?? 0) > maxTokens) {
				maxTokens = child.tokens ?? 0;
				targetIndex = index;
			}
		});
		if (targetIndex >= 0) {
			const target = scaledChildren[targetIndex];
			if (target) scaledChildren[targetIndex] = { ...target, tokens: (target.tokens ?? 0) + difference };
		}
	}
	return { ...row, tokens: sumRows(scaledChildren), children: scaledChildren };
}

function applyGroupTokenCount(
	group: ContextReportRow,
	exactTotal: number | null | undefined,
	rowCounts: Record<string, number | null>,
): ContextReportRow {
	const children = group.children ?? [];
	if (children.length === 0) {
		return exactTotal === null || exactTotal === undefined ? group : { ...group, tokens: exactTotal };
	}
	if (exactTotal === null || exactTotal === undefined) {
		const hasRowCounts = children.some((child) => rowCounts[child.id] !== undefined);
		if (!hasRowCounts) return group;
		const nextChildren = children.map((child) =>
			rowCounts[child.id] === undefined ? child : { ...child, tokens: rowCounts[child.id] },
		);
		return { ...group, tokens: sumRows(nextChildren), children: nextChildren };
	}
	const weights = children.map((child) => rowCounts[child.id] ?? child.tokens ?? 0);
	return allocateChildrenToTotal(group, exactTotal, weights);
}

export function buildContextReport(input: ContextReportInput): ContextReport {
	const instructions = instructionRows(input);
	const tools = toolRows(input);
	const conversation = messageRows(input.messages);
	const groups: ContextReportRow[] = [
		{ id: "instructions", label: "Instructions", tokens: sumRows(instructions), children: instructions },
		{ id: "tools", label: "Tool definitions", tokens: sumRows(tools), children: tools },
		{ id: "conversation", label: "Conversation", tokens: sumRows(conversation), children: conversation },
	];

	const tokenCounts = input.tokenCounts;
	const groupCounts = tokenCounts?.groups ?? {};
	const rowCounts = tokenCounts?.rows ?? {};
	const hasGroupCount = Object.values(groupCounts).some((value) => value !== null && value !== undefined);
	const hasRowCount = Object.values(rowCounts).some((value) => value !== null && value !== undefined);
	const hasProviderCounts = hasGroupCount || hasRowCount;
	const countedGroups = hasProviderCounts
		? groups.map((group) => applyGroupTokenCount(group, groupCounts[group.id as ContextGroupId] ?? null, rowCounts))
		: groups;

	// Without provider tokenizer counts, the host may still know the real request
	// size from provider usage or its calibrated live-context estimator. Anchor the
	// estimated rows to that total when it exists; keep raw estimates before the
	// first response or when the host cannot report a total.
	const estimatedUsed = sumRows(groups);
	const reportedTokens = input.reportedTokens;
	const shouldAnchor =
		!hasProviderCounts &&
		reportedTokens !== undefined &&
		reportedTokens !== null &&
		reportedTokens > 0 &&
		estimatedUsed !== null &&
		estimatedUsed > 0;
	const finalGroups = shouldAnchor
		? scaleRows(groups, (reportedTokens as number) / (estimatedUsed as number))
		: countedGroups;
	const usedTokens = sumRows(finalGroups);
	const percent = usedTokens !== null && input.contextWindow > 0 ? (usedTokens / input.contextWindow) * 100 : null;
	const freeTokens =
		usedTokens !== null && input.contextWindow > 0
			? Math.max(0, input.contextWindow - usedTokens - (input.reserveTokens ?? 0))
			: null;
	const tokenSource: ContextReport["tokenSource"] = hasProviderCounts ? "provider" : "estimate";
	return {
		contextWindow: input.contextWindow,
		usedTokens,
		percent,
		reserveTokens: input.reserveTokens,
		freeTokens,
		groups: finalGroups,
		tokenSource,
	};
}

export async function captureContextReport(ctx: ExtensionCommandContext): Promise<ContextReport> {
	const snapshot = ctx.getContextReportSnapshot?.();
	const messages =
		snapshot?.messages ??
		ctx.sessionManager
			.buildContextEntries()
			.flatMap(sessionEntryToContextMessages)
			.filter((message) => !(message.role === "bashExecution" && message.excludeFromContext));
	const usage = ctx.getContextUsage();
	const input: ContextReportInput = {
		systemPrompt: snapshot?.systemPrompt ?? ctx.getSystemPrompt(),
		systemPromptOptions: snapshot?.systemPromptOptions ?? ctx.getSystemPromptOptions(),
		tools: snapshot?.tools ?? ctx.getToolCatalog?.(),
		mcpServerNames: snapshot?.mcpServerNames ?? getStepMcpStatuses().map((status) => status.name),
		messages,
		contextWindow: snapshot?.contextWindow || usage?.contextWindow || ctx.model?.contextWindow || 0,
		reserveTokens: snapshot?.reserveTokens ?? usage?.reserveTokens,
		reportedTokens: usage?.tokens ?? null,
	};

	const model = resolveStepTokenCountModel(ctx.modelRegistry, ctx.model);
	if (model) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) {
			const segments = buildContextTokenCountSegments(input, model.api);
			if (segments.length > 0) {
				input.tokenCounts = await countContextTokenCounts({ model, auth, segments, signal: ctx.signal });
			}
		}
	}
	return buildContextReport(input);
}

function formatTokens(tokens: number | null): string {
	return tokens === null ? "--" : tokens.toLocaleString("en-US");
}

function formatRow(row: ContextReportRow, usedTokens: number | null, indent = ""): string {
	const share =
		row.tokens !== null && usedTokens !== null && usedTokens > 0
			? `${((row.tokens / usedTokens) * 100).toFixed(1)}%`
			: "--";
	return `${indent}${row.label}`.padEnd(32) + formatTokens(row.tokens).padStart(12) + share.padStart(9);
}

export function contextReportRows(report: ContextReport, showAll = false): string[] {
	const used = formatTokens(report.usedTokens);
	const window = report.contextWindow > 0 ? report.contextWindow.toLocaleString("en-US") : "--";
	const percent = report.percent === null ? "--" : `${report.percent.toFixed(1)}%`;
	const sourceLabel =
		report.tokenSource === "provider" ? "Context Usage (token-count API)" : "Context Usage (estimated)";
	const rows = [sourceLabel, `${used} / ${window} tokens (${percent})`];
	for (const group of report.groups) {
		rows.push("", formatRow(group, report.usedTokens));
		for (const child of group.children ?? []) {
			if (!showAll && !nonZero(child)) continue;
			rows.push(formatRow(child, report.usedTokens, "  "));
			if (showAll) {
				for (const detail of child.children ?? []) {
					rows.push(formatRow(detail, report.usedTokens, "    ") + (detail.detail ? `  ${detail.detail}` : ""));
				}
			}
		}
	}
	rows.push(
		"",
		`${"Free after compaction reserve"}`.padEnd(32) + formatTokens(report.freeTokens).padStart(12),
		`${"Compaction reserve"}`.padEnd(32) + formatTokens(report.reserveTokens ?? null).padStart(12),
	);
	return rows;
}

export function contextMeterSegments(report: ContextReport, width = 40): ContextMeterSegment[] {
	if (report.usedTokens === null || report.contextWindow <= 0 || width <= 0) return [];
	const usedCells = Math.min(width, Math.round((report.usedTokens / report.contextWindow) * width));
	const reserveCells = Math.min(
		width - usedCells,
		Math.round(((report.reserveTokens ?? 0) / report.contextWindow) * width),
	);
	const weights = report.groups.map((group) => Math.max(0, group.tokens ?? 0));
	const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
	const allocations = weights.map((weight) => (totalWeight > 0 ? (weight / totalWeight) * usedCells : 0));
	const cells = allocations.map(Math.floor);
	let remaining = usedCells - cells.reduce((sum, value) => sum + value, 0);
	const order = allocations
		.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
		.sort((a, b) => b.fraction - a.fraction);
	for (let index = 0; remaining > 0 && order.length > 0; index = (index + 1) % order.length) {
		cells[order[index].index] += 1;
		remaining -= 1;
	}
	const visibleGroups = weights.filter((weight) => weight > 0).length;
	if (usedCells >= visibleGroups) {
		for (const [index, weight] of weights.entries()) {
			if (weight <= 0 || cells[index] > 0) continue;
			const donor = cells.indexOf(Math.max(...cells));
			if (donor < 0 || cells[donor] <= 1) continue;
			cells[donor] -= 1;
			cells[index] = 1;
		}
	}
	const segments: ContextMeterSegment[] = [];
	for (const [index, group] of report.groups.entries()) {
		const id = group.id as ContextMeterSegment;
		for (let count = 0; count < cells[index]; count++) segments.push(id);
	}
	for (let count = 0; count < reserveCells; count++) segments.push("reserve");
	while (segments.length < width) segments.push("free");
	return segments;
}
