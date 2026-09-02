/**
 * Step's native subagent extension.
 *
 * This is intentionally a thin adapter around the public Pi ExtensionAPI. A
 * child is another Step/Pi process in JSON mode, while the parent keeps the
 * normal AgentSession loop and native TUI renderer. No second session
 * authority is created here.
 */

import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Message, StringEnum, type Usage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { CONFIG_DIR_NAME } from "../config.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	ToolRenderResultOptions,
} from "../core/extensions/types.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import { getMarkdownTheme } from "../modes/interactive/theme/theme.ts";
import { resolveStepAgentDir, resolveStepConfigDir } from "../step/environment.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "../step/telemetry.ts";
import {
	discoverStepAgents,
	formatStepAgentCatalog,
	type StepAgentConfig,
	type StepAgentDiscoveryResult,
	type StepAgentScope,
} from "./step-subagent-agents.ts";

const execFile = promisify(execFileCallback);

const MAX_PARALLEL_TASKS = 8;
const DEFAULT_CONCURRENCY = 4;
const MAX_STDERR_CHARS = 32_000;
const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 256;
const COLLAPSED_OUTPUT_LINES = 8;
const CHILD_MARKER = "STEP_CLI_SUBAGENT_CHILD";

/** Tool names in agent files may use either Pi's native names or Step's
 * model-facing aliases. Child Step processes expose the latter. */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
	read: "read_file",
	bash: "run_command",
	edit: "edit_file",
	write: "write_file",
	find: "find_files",
	grep: "search_files",
	ls: "list_directory",
};

export interface StepSubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface StepSubagentRunResult {
	messages: Message[];
	stderr: string;
	exitCode: number;
	usage: StepSubagentUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Live projection populated from Pi's JSON event stream. */
	activeText?: string;
	activeTool?: string;
	activeToolArgs?: string;
	activeToolOutput?: string;
	lastEvent?: string;
	startedAt?: number;
	updatedAt?: number;
}

export interface StepSubagentRunInput {
	agent: StepAgentConfig;
	task: string;
	cwd: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	signal?: AbortSignal;
	onUpdate?: (result: StepSubagentRunResult) => void;
}

/** Injectable runner used by embedders and tests. The default runner launches
 * the current Step executable/script, preserving the resolved Step provider. */
export type StepSubagentRunner = (input: StepSubagentRunInput) => Promise<StepSubagentRunResult>;

export interface StepWorktreeLease {
	path: string;
	branch: string;
	/** Remove the worktree and its temporary parent. Safe to call repeatedly. */
	cleanup(): Promise<void>;
}

export interface StepWorktreeManager {
	allocate(baseCwd: string, label: string): Promise<StepWorktreeLease>;
}

export interface StepSubagentResultRecord extends StepSubagentRunResult {
	agent: string;
	agentSource: StepAgentConfig["source"] | "unknown";
	task: string;
	status: "running" | "completed" | "failed" | "aborted";
	step?: number;
	worktreePath?: string;
	worktreeBranch?: string;
}

export interface StepSubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: StepAgentScope;
	userAgentsDir: string;
	projectAgentsDir: string | null;
	results: StepSubagentResultRecord[];
	/** Present for background lanes and useful to a renderer/list command. */
	agentId?: string;
	status?: "running" | "completed" | "failed" | "aborted";
	startedAt?: number;
	updatedAt?: number;
}

export interface StepSubagentExtensionOptions {
	/** Global Step agent root. Defaults to `~/.step-cli/agent`. */
	agentDir?: string;
	/** Project resource directory. Defaults to `.step-cli`. */
	configDirName?: string;
	/** Include the built-in general/explore/review/planner roles. */
	includeBuiltinAgents?: boolean;
	/** Maximum number of tasks accepted in one parallel call. */
	maxParallelTasks?: number;
	/** Number of child processes allowed to run at once. */
	maxConcurrency?: number;
	/** Optional isolated git worktree implementation. */
	worktreeManager?: StepWorktreeManager;
	/** Optional child runner, primarily useful for embedded hosts/tests. */
	runner?: StepSubagentRunner;
	/** Optional process reporter; telemetry never owns child execution. */
	telemetry?: StepTelemetryReporter;
}

interface BackgroundAgentLane {
	id: string;
	alias?: string;
	group?: string;
	params: SubagentParams;
	ctx: ExtensionContext;
	controller: AbortController;
	status: "running" | "completed" | "failed" | "aborted";
	details: StepSubagentDetails;
	result?: AgentToolResult<StepSubagentDetails>;
	promise: Promise<AgentToolResult<StepSubagentDetails>>;
	queuedPrompts: string[];
	startedAt: number;
	updatedAt: number;
	/** Incremented whenever a lane starts a new turn; stale child callbacks are ignored. */
	runGeneration: number;
}

interface StepSubagentTaskInput {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	contextMode?: "inherit" | "fresh";
	isolateWorkspace?: boolean;
	worktreeName?: string;
	retainWorktree?: boolean;
}

// Keep the model-facing contract identical to Pi's subagent example. Step
// adapts discovery, process invocation, storage, telemetry, and theme only.
const StepTaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const StepChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const StepAgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const StepSubagentParamsSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(StepTaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(StepChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(StepAgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

type PublicSubagentParams = Static<typeof StepSubagentParamsSchema>;

/** Internal controls retained for Step's background-lane implementation. They
 * are intentionally absent from the model-facing Pi schema. */
interface StepSubagentRuntimeParams {
	run_in_background?: boolean;
	alias?: string;
	group?: string;
	isolateWorkspace?: boolean;
	worktreeName?: string;
	retainWorktree?: boolean;
}

type SubagentParams = PublicSubagentParams & StepSubagentRuntimeParams;

function emptyUsage(): StepSubagentUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

function cloneUsage(usage: StepSubagentUsage): StepSubagentUsage {
	return { ...usage };
}

function isMessage(value: unknown): value is Message {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as { role?: unknown; content?: unknown };
	return (
		(candidate.role === "assistant" || candidate.role === "user" || candidate.role === "toolResult") &&
		(Array.isArray(candidate.content) || typeof candidate.content === "string")
	);
}

function isAssistantMessage(message: Message): message is Extract<Message, { role: "assistant" }> {
	return message.role === "assistant";
}

function assistantText(message: Message): string {
	if (!isAssistantMessage(message)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function finalOutput(messages: readonly Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const text = assistantText(messages[index]);
		if (text) return text;
	}
	return "";
}

function usageFromMessage(message: Message, usage: StepSubagentUsage): void {
	if (!isAssistantMessage(message)) return;
	usage.turns += 1;
	const messageUsage = message.usage as Usage | undefined;
	if (!messageUsage) return;
	usage.input += messageUsage.input || 0;
	usage.output += messageUsage.output || 0;
	usage.cacheRead += messageUsage.cacheRead || 0;
	usage.cacheWrite += messageUsage.cacheWrite || 0;
	usage.contextTokens = messageUsage.totalTokens || usage.contextTokens;
	usage.cost += messageUsage.cost?.total || 0;
}

function sanitizeLabel(value: string, fallback = "agent"): string {
	const cleaned = value
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	return cleaned || fallback;
}

function normalizeChildTools(tools: readonly string[] | undefined): string[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return [...new Set(tools.map((tool) => TOOL_ALIASES[tool] ?? tool).filter((tool) => tool.length > 0))];
}

function isFailed(result: Pick<StepSubagentRunResult, "exitCode" | "stopReason">): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function statusForResult(result: StepSubagentRunResult): StepSubagentResultRecord["status"] {
	if (result.exitCode === -1) return "running";
	if (result.stopReason === "aborted") return "aborted";
	return isFailed(result) ? "failed" : "completed";
}

function resultRecord(
	agent: string,
	task: string,
	result: StepSubagentRunResult,
	extra: Partial<Pick<StepSubagentResultRecord, "agentSource" | "step" | "worktreePath" | "worktreeBranch">> = {},
): StepSubagentResultRecord {
	return {
		agent,
		agentSource: extra.agentSource ?? "unknown",
		task,
		status: statusForResult(result),
		...result,
		...extra,
		usage: cloneUsage(result.usage),
	};
}

function makeEmptyResult(agent: string, task: string): StepSubagentResultRecord {
	return {
		agent,
		agentSource: "unknown",
		task,
		status: "running",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		startedAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function resultText(result: StepSubagentRunResult): string {
	if (isFailed(result)) return result.errorMessage || result.stderr || finalOutput(result.messages) || "(no output)";
	return finalOutput(result.messages) || "(no output)";
}

function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n\n[output truncated]`;
}

function formatUsage(usage: StepSubagentUsage, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`in:${usage.input}`);
	if (usage.output) parts.push(`out:${usage.output}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatElapsed(record: StepSubagentResultRecord): string {
	const started = record.startedAt;
	if (!started) return "";
	const end = record.status === "running" ? Date.now() : (record.updatedAt ?? Date.now());
	const seconds = Math.max(0, Math.floor((end - started) / 1000));
	return `${seconds}s`;
}

function resultDetailsText(details: StepSubagentDetails): string {
	return details.results
		.map((result) => {
			const worktree = result.worktreePath ? ` worktree=${result.worktreePath}` : "";
			return `${result.agent}: ${result.status}${worktree}`;
		})
		.join("; ");
}

function buildDetails(
	mode: StepSubagentDetails["mode"],
	discovery: StepAgentDiscoveryResult,
	scope: StepAgentScope,
	results: StepSubagentResultRecord[],
): StepSubagentDetails {
	return {
		mode,
		agentScope: scope,
		userAgentsDir: discovery.userAgentsDir,
		projectAgentsDir: discovery.projectAgentsDir,
		results,
	};
}

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const result = await execFile("git", ["-C", cwd, ...args], {
		maxBuffer: 2 * 1024 * 1024,
	});
	return result.stdout.trim();
}

/** Create a detached branch/worktree outside the repository. Keeping the
 * worktree outside the project avoids exposing it to the parent agent's file
 * tools while still making the path available in the result for review or
 * cherry-picking. */
async function allocateStepWorktree(baseCwd: string, label: string): Promise<StepWorktreeLease> {
	const repositoryRoot = await runGit(baseCwd, ["rev-parse", "--show-toplevel"]);
	if (!repositoryRoot) throw new Error("The child working directory is not a Git repository");

	const parent = await mkdtemp(path.join(os.tmpdir(), "step-cli-worktree-"));
	const worktreePath = path.join(parent, "workspace");
	const branch = `step-agent/${sanitizeLabel(label)}-${randomUUID().slice(0, 8)}`;
	try {
		await runGit(repositoryRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
	} catch (error) {
		await rm(parent, { recursive: true, force: true });
		throw error;
	}

	let cleaned = false;
	return {
		path: worktreePath,
		branch,
		cleanup: async () => {
			if (cleaned) return;
			cleaned = true;
			try {
				await runGit(repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		},
	};
}

function currentStepInvocation(args: string[]): {
	command: string;
	args: string[];
} {
	const script = process.argv[1];
	const virtualScript = script?.startsWith("/$bunfs/") || script?.includes("$bunfs");
	if (script && !virtualScript && existsSync(script) && /\.(?:[cm]?js|[cm]?ts)$/iu.test(script)) {
		// `pnpm step` and the Node distribution both expose the Step script as
		// argv[1]. Reusing it preserves the Step provider, storage namespace, and
		// all product-level defaults for the child.
		return { command: process.execPath, args: [script, ...args] };
	}

	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(?:node|bun)(?:\.exe)?$/u.test(executable)) {
		return { command: process.execPath, args };
	}
	return { command: "step", args };
}

function appendMessage(messages: Message[], message: Message): void {
	messages.push(message);
	if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
}

function parseJsonEvent(
	line: string,
	current: StepSubagentRunResult,
	onUpdate: ((result: StepSubagentRunResult) => void) | undefined,
): void {
	if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) return;
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (!event || typeof event !== "object" || Array.isArray(event)) return;
	const candidate = event as Record<string, unknown>;
	const type = typeof candidate.type === "string" ? candidate.type : "";
	current.lastEvent = type || current.lastEvent;
	current.updatedAt = Date.now();

	// JSON mode emits deltas without the cumulative assistant snapshot. Keep a
	// small live projection for the parent renderer while retaining final
	// messages as the authoritative result.
	if (type === "message_start") {
		current.activeText = "";
		current.activeTool = undefined;
		current.activeToolArgs = undefined;
		current.activeToolOutput = undefined;
	} else if (type === "message_update") {
		const update = isRecordValue(candidate.assistantMessageEvent) ? candidate.assistantMessageEvent : undefined;
		const updateType = typeof update?.type === "string" ? update.type : "";
		const delta =
			typeof update?.delta === "string" ? update.delta : typeof update?.text === "string" ? update.text : "";
		if (delta && /(?:text|reasoning|thinking).*delta|delta/u.test(updateType)) {
			current.activeText = `${current.activeText ?? ""}${delta}`.slice(-50_000);
		}
		if (update && updateType === "toolcall_start") {
			current.activeTool =
				typeof update.toolName === "string"
					? update.toolName
					: typeof update.name === "string"
						? update.name
						: "tool";
			current.activeToolArgs = "";
		} else if (updateType === "toolcall_delta" && delta) {
			current.activeToolArgs = `${current.activeToolArgs ?? ""}${delta}`.slice(-20_000);
		}
	} else if (type === "tool_execution_start") {
		current.activeTool = typeof candidate.toolName === "string" ? candidate.toolName : "tool";
		current.activeToolArgs = stringifyLiveValue(candidate.args);
		current.activeToolOutput = undefined;
	} else if (type === "tool_execution_update") {
		current.activeToolOutput = stringifyLiveValue(candidate.partialResult);
	} else if (type === "tool_execution_end") {
		current.activeToolOutput = stringifyLiveValue(candidate.result);
		current.activeTool = undefined;
		current.activeToolArgs = undefined;
	}

	const message = candidate.message;
	if ((type === "message_end" || type === "tool_result_end") && isMessage(message)) {
		appendMessage(current.messages, message);
		usageFromMessage(message, current.usage);
		if (isAssistantMessage(message)) {
			if (message.model) current.model = message.model;
			current.stopReason = message.stopReason;
			current.errorMessage = message.errorMessage;
			current.activeText = assistantText(message) || current.activeText;
			current.activeTool = undefined;
			current.activeToolArgs = undefined;
		}
	}
	onUpdate?.({
		...current,
		messages: [...current.messages],
		usage: cloneUsage(current.usage),
	});
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringifyLiveValue(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value.slice(-20_000);
	try {
		return JSON.stringify(value).slice(-20_000);
	} catch {
		return String(value).slice(-20_000);
	}
}

/** Default child runner. It consumes Pi's JSON event stream and emits partial
 * snapshots so the parent Pi ToolExecutionComponent can render live progress. */
export async function runStepSubagentProcess(input: StepSubagentRunInput): Promise<StepSubagentRunResult> {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "step-cli-subagent-"));
	const promptPath = path.join(tempDir, "system-prompt.md");
	const args = ["--mode", "json", "-p", "--no-session"];
	const model = input.agent.model ?? input.model;
	if (model) args.push("--model", model);
	if (input.thinkingLevel && !input.agent.model) args.push("--thinking", input.thinkingLevel);
	const tools = normalizeChildTools(input.agent.tools);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));
	if (input.agent.systemPrompt.trim()) {
		await writeFile(promptPath, input.agent.systemPrompt, {
			encoding: "utf8",
			mode: 0o600,
		});
		args.push("--append-system-prompt", promptPath);
	}
	args.push(`Task: ${input.task}`);

	const current: StepSubagentRunResult = {
		messages: [],
		stderr: "",
		exitCode: -1,
		usage: emptyUsage(),
		model,
		startedAt: Date.now(),
		updatedAt: Date.now(),
	};
	let processError: string | undefined;
	let aborted = input.signal?.aborted === true;
	let child: ReturnType<typeof spawn> | undefined;
	let abortTimer: ReturnType<typeof setTimeout> | undefined;
	let removeAbortListener: (() => void) | undefined;

	try {
		const invocation = currentStepInvocation(args);
		const childEnv = { ...process.env, [CHILD_MARKER]: "1" };
		const result = await new Promise<number>((resolve) => {
			let settled = false;
			const settle = (code: number): void => {
				if (settled) return;
				settled = true;
				resolve(code);
			};
			child = spawn(invocation.command, invocation.args, {
				cwd: input.cwd,
				env: childEnv,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			child.stdout?.on("data", (chunk: Buffer | string) => {
				buffer += chunk.toString();
				if (Buffer.byteLength(buffer, "utf8") > MAX_JSON_LINE_BYTES * 2) {
					processError = "Subagent emitted an oversized JSON event";
					child?.kill("SIGTERM");
					return;
				}
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) parseJsonEvent(line.trimEnd(), current, input.onUpdate);
			});
			child.stderr?.on("data", (chunk: Buffer | string) => {
				if (current.stderr.length >= MAX_STDERR_CHARS) return;
				current.stderr += chunk.toString().slice(0, MAX_STDERR_CHARS - current.stderr.length);
			});
			child.once("error", (error) => {
				processError = error.message;
				settle(1);
			});
			child.once("close", (code) => {
				if (buffer.trim()) parseJsonEvent(buffer.trim(), current, input.onUpdate);
				settle(code ?? 1);
			});

			const terminate = (): void => {
				if (!child || child.killed) return;
				aborted = true;
				child.kill("SIGTERM");
				abortTimer = setTimeout(() => {
					if (child && child.exitCode === null && child.signalCode === null) {
						child.kill("SIGKILL");
					}
				}, 5_000);
				abortTimer.unref?.();
			};
			if (aborted) terminate();
			else if (input.signal) {
				input.signal.addEventListener("abort", terminate, { once: true });
				removeAbortListener = () => input.signal?.removeEventListener("abort", terminate);
			}
		});
		current.exitCode = result;
		if (aborted) {
			current.stopReason = "aborted";
			current.errorMessage = "Subagent was aborted";
		} else if (processError) {
			current.stopReason = "error";
			current.errorMessage = processError;
		}
		return {
			...current,
			messages: [...current.messages],
			usage: cloneUsage(current.usage),
		};
	} finally {
		if (abortTimer) clearTimeout(abortTimer);
		removeAbortListener?.();
		await rm(tempDir, { recursive: true, force: true });
	}
}

function makeToolResult(details: StepSubagentDetails, text: string): AgentToolResult<StepSubagentDetails> {
	return { content: [{ type: "text", text }], details };
}

function makeFailureResult(
	agent: string,
	task: string,
	message: string,
	source: StepAgentConfig["source"] | "unknown" = "unknown",
): StepSubagentResultRecord {
	return resultRecord(
		agent,
		task,
		{
			messages: [],
			stderr: message,
			exitCode: 1,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: message,
		},
		{ agentSource: source },
	);
}

function taskLabel(task: StepSubagentTaskInput, index?: number): string {
	return sanitizeLabel(task.worktreeName ?? task.agent, index === undefined ? "agent" : `agent-${index + 1}`);
}

function taskFromParams(params: SubagentParams): StepSubagentTaskInput | undefined {
	const task = params.task?.trim();
	const agent = params.agent?.trim();
	if (!task || !agent) return undefined;
	return {
		agent,
		task,
		cwd: params.cwd,
		isolateWorkspace: params.isolateWorkspace,
		worktreeName: params.worktreeName,
		retainWorktree: params.retainWorktree,
	};
}

function normalizeTaskInput(task: Static<typeof StepTaskItem> | Static<typeof StepChainItem>): StepSubagentTaskInput {
	const runtimeTask = task as Static<typeof StepTaskItem> & {
		isolateWorkspace?: boolean;
		worktreeName?: string;
		retainWorktree?: boolean;
	};
	return {
		agent: task.agent,
		task: task.task,
		cwd: task.cwd,
		isolateWorkspace: runtimeTask.isolateWorkspace,
		worktreeName: runtimeTask.worktreeName,
		retainWorktree: runtimeTask.retainWorktree,
	};
}

async function confirmProjectAgents(
	ctx: ExtensionContext,
	params: SubagentParams,
	discovery: StepAgentDiscoveryResult,
	tasks: readonly StepSubagentTaskInput[],
): Promise<boolean> {
	if (params.confirmProjectAgents === false || !ctx.hasUI || ctx.isProjectTrusted()) return true;
	if (params.agentScope === "user") return true;
	const projectNames = [...new Set(tasks.map((task) => task.agent))].filter((name) =>
		discovery.agents.some((agent) => agent.name === name && agent.source === "project"),
	);
	if (projectNames.length === 0) return true;
	return ctx.ui.confirm(
		"Run project-local agents?",
		`Agents: ${projectNames.join(", ")}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject definitions are repository-controlled. Continue only for a trusted repository.`,
	);
}

function statusIcon(status: StepSubagentResultRecord["status"], theme: Theme): string {
	if (status === "running") return theme.fg("warning", "~");
	if (status === "completed") return theme.fg("success", "+");
	return theme.fg("error", "x");
}

function renderRecordSummary(record: StepSubagentResultRecord, theme: Theme): string {
	const output =
		record.activeText ||
		finalOutput(record.messages) ||
		(record.status === "running" ? "(running...)" : resultText(record));
	const lines = output.split(/\r?\n/u).filter((line) => line.trim().length > 0);
	const preview = lines.slice(-COLLAPSED_OUTPUT_LINES).join("\n");
	const omitted = Math.max(0, lines.length - COLLAPSED_OUTPUT_LINES);
	let text = `${statusIcon(record.status, theme)} ${theme.fg("accent", record.agent)} ${theme.fg("muted", `(${record.agentSource})`)} ${theme.fg("dim", formatElapsed(record))}`;
	if (record.worktreePath) text += `\n  ${theme.fg("dim", `worktree: ${record.worktreePath}`)}`;
	if (record.activeTool) {
		text += `\n  ${theme.fg("warning", `running ${record.activeTool}`)}`;
		if (record.activeToolArgs) text += ` ${theme.fg("dim", truncateText(record.activeToolArgs, 240))}`;
	}
	if (record.activeToolOutput) text += `\n  ${theme.fg("toolOutput", truncateText(record.activeToolOutput, 400))}`;
	if (preview) text += `\n${theme.fg("toolOutput", preview)}`;
	if (omitted > 0) text += `\n${theme.fg("dim", `... ${omitted} earlier lines`)}`;
	return text;
}

function renderExpandedRecord(record: StepSubagentResultRecord, theme: Theme): Container {
	const container = new Container();
	container.addChild(
		new Text(
			`${statusIcon(record.status, theme)} ${theme.bold(record.agent)} ${theme.fg("muted", `(${record.agentSource})`)}`,
			0,
			0,
		),
	);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "Task"), 0, 0));
	container.addChild(new Text(theme.fg("dim", record.task), 0, 0));
	if (record.worktreePath) {
		container.addChild(new Text(theme.fg("muted", `Worktree: ${record.worktreePath}`), 0, 0));
		container.addChild(new Text(theme.fg("dim", `Branch: ${record.worktreeBranch ?? "detached"}`), 0, 0));
	}
	container.addChild(new Spacer(1));
	const output = record.activeText || finalOutput(record.messages) || resultText(record);
	container.addChild(new Text(theme.fg("muted", "Output"), 0, 0));
	if (output) container.addChild(new Markdown(truncateText(output, 50_000), 0, 0, getMarkdownTheme()));
	if (record.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${record.errorMessage}`), 0, 0));
	const usage = formatUsage(record.usage, record.model);
	if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	if (record.activeTool) {
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				theme.fg("warning", `Running ${record.activeTool}`) +
					(record.activeToolArgs ? ` ${theme.fg("dim", truncateText(record.activeToolArgs, 1000))}` : ""),
				0,
				0,
			),
		);
	}
	return container;
}

function renderSubagentResult(
	result: AgentToolResult<StepSubagentDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const details = result.details;
	if (!details || details.results.length === 0) {
		const text = result.content.find((block) => block.type === "text");
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}
	const running = details.results.filter((record) => record.status === "running").length;
	const completed = details.results.filter((record) => record.status === "completed").length;
	const heading =
		details.mode === "parallel"
			? `${completed}/${details.results.length} complete${running > 0 ? `, ${running} running` : ""}`
			: (details.results[0]?.status ?? "done");
	if (options.expanded) {
		const container = new Container();
		container.addChild(new Text(`${theme.bold("agent")} ${theme.fg("accent", heading)}`, 0, 0));
		for (const record of details.results) {
			container.addChild(new Spacer(1));
			container.addChild(renderExpandedRecord(record, theme));
		}
		return container;
	}
	let text = `${theme.bold("agent")} ${theme.fg("accent", heading)}`;
	for (const record of details.results) text += `\n\n${renderRecordSummary(record, theme)}`;
	if (running === 0) text += `\n${theme.fg("dim", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

async function executeSubagent(
	params: SubagentParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<StepSubagentDetails> | undefined,
	ctx: ExtensionContext,
	options: Required<
		Pick<
			StepSubagentExtensionOptions,
			"agentDir" | "configDirName" | "includeBuiltinAgents" | "maxParallelTasks" | "maxConcurrency"
		>
	> & {
		worktreeManager: StepWorktreeManager;
		runner: StepSubagentRunner;
		telemetry?: StepTelemetryReporter;
	},
): Promise<AgentToolResult<StepSubagentDetails>> {
	const scope = params.agentScope ?? "user";
	const discovery = await discoverStepAgents(ctx.cwd, {
		agentDir: options.agentDir,
		configDirName: options.configDirName,
		includeBuiltin: options.includeBuiltinAgents,
		scope,
	});
	const parallelInput = params.tasks;
	const chainInput = params.chain;
	// This mirrors Pi's example: an empty optional array does not select a mode.
	const hasParallelInput = (parallelInput?.length ?? 0) > 0;
	const hasChainInput = (chainInput?.length ?? 0) > 0;
	const single = !hasParallelInput && !hasChainInput ? taskFromParams(params) : undefined;
	const parallel = hasParallelInput ? parallelInput!.map(normalizeTaskInput) : undefined;
	const chain = hasChainInput ? chainInput!.map(normalizeTaskInput) : undefined;
	const modeCount = Number(Boolean(single)) + Number(hasParallelInput) + Number(hasChainInput);
	if (modeCount !== 1) {
		const details = buildDetails("single", discovery, scope, []);
		return makeToolResult(
			details,
			`Invalid parameters. Provide exactly one mode. Available agents: ${formatStepAgentCatalog(discovery.agents)}`,
		);
	}
	if (parallel && parallel.length > options.maxParallelTasks) {
		const details = buildDetails("parallel", discovery, scope, []);
		return makeToolResult(
			details,
			`Too many parallel tasks (${parallel.length}); maximum is ${options.maxParallelTasks}.`,
		);
	}
	const tasks = parallel ?? chain ?? [single!];
	const mode: StepSubagentDetails["mode"] = chain ? "chain" : parallel ? "parallel" : "single";
	if (!(await confirmProjectAgents(ctx, params, discovery, tasks))) {
		const details = buildDetails(mode, discovery, scope, []);
		return makeToolResult(details, "Canceled: project-local agents not approved.");
	}

	const records = tasks.map((task) => makeEmptyResult(task.agent, task.task));
	const execution = parallel ? "background" : "blocking";
	const createdAt = tasks.map(() => Date.now());
	const createdTasks = new Set<number>();
	const reportCreated = (agent: StepAgentConfig, index: number): void => {
		if (!options.telemetry) return;
		createdTasks.add(index);
		trackStepTelemetry(options.telemetry, "subagent_task_created", {
			execution,
			agent_type: agent.name,
			model_profile: agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "inherited"),
		});
		createdAt[index] = Date.now();
	};
	const reportFinished = (record: StepSubagentResultRecord, index: number): void => {
		if (!options.telemetry || !createdTasks.has(index)) return;
		const status =
			record.status === "completed" ? "completed" : record.status === "aborted" ? "interrupted" : "error";
		trackStepTelemetry(options.telemetry, "subagent_task_finished", {
			execution,
			status,
			duration_ms: Math.max(0, Date.now() - (createdAt[index] ?? Date.now())),
		});
	};
	const emit = (mode: StepSubagentDetails["mode"]): void => {
		onUpdate?.(
			makeToolResult(
				buildDetails(
					mode,
					discovery,
					scope,
					records.map((record) => ({
						...record,
						messages: [...record.messages],
						usage: cloneUsage(record.usage),
					})),
				),
				resultDetailsText(buildDetails(mode, discovery, scope, records)),
			),
		);
	};

	const runOne = async (task: StepSubagentTaskInput, index: number): Promise<StepSubagentResultRecord> => {
		const agent = discovery.agents.find((candidate) => candidate.name === task.agent);
		if (!agent) {
			const failed = makeFailureResult(
				task.agent,
				task.task,
				`Unknown agent: "${task.agent}". Available agents: ${formatStepAgentCatalog(discovery.agents)}`,
			);
			records[index] = failed;
			emit(mode);
			reportFinished(failed, index);
			return failed;
		}
		reportCreated(agent, index);
		const baseCwd = path.resolve(ctx.cwd, task.cwd ?? ".");
		let worktree: StepWorktreeLease | undefined;
		let childCwd = baseCwd;
		try {
			if (task.isolateWorkspace) {
				worktree = await options.worktreeManager.allocate(baseCwd, taskLabel(task, index));
				childCwd = worktree.path;
			}
			const update = (partial: StepSubagentRunResult): void => {
				records[index] = resultRecord(agent.name, task.task, partial, {
					agentSource: agent.source,
					worktreePath: worktree?.path,
					worktreeBranch: worktree?.branch,
				});
				emit(parallel ? "parallel" : "single");
			};
			const child = await options.runner({
				agent,
				task: task.task,
				cwd: childCwd,
				model: task.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
				thinkingLevel: ctx.thinkingLevel,
				signal,
				onUpdate: update,
			});
			const completed = resultRecord(agent.name, task.task, child, {
				agentSource: agent.source,
				worktreePath: worktree?.path,
				worktreeBranch: worktree?.branch,
			});
			records[index] = completed;
			emit(mode);
			if (worktree && task.retainWorktree === false) await worktree.cleanup();
			reportFinished(completed, index);
			return completed;
		} catch (error) {
			if (worktree && task.retainWorktree === false) await worktree.cleanup().catch(() => undefined);
			const message = error instanceof Error ? error.message : String(error);
			const failed = makeFailureResult(agent.name, task.task, message, agent.source);
			records[index] = failed;
			emit(mode);
			reportFinished(failed, index);
			return failed;
		}
	};

	if (parallel) await mapWithConcurrency(parallel, options.maxConcurrency, runOne);
	else if (chain) {
		let previous = "";
		for (let index = 0; index < chain.length; index++) {
			const task = {
				...chain[index],
				task: chain[index].task.replace(/\{previous\}/g, previous),
			};
			const record = await runOne(task, index);
			previous = finalOutput(record.messages) || resultText(record);
			if (record.status !== "completed") break;
		}
	} else await runOne(tasks[0], 0);
	const finalDetails = buildDetails(mode, discovery, scope, records);
	if (mode === "parallel") {
		const success = records.filter((record) => record.status === "completed").length;
		const summaries = records.map(
			(record) => `### ${record.agent} (${record.status})\n\n${truncateText(resultText(record), 50_000)}`,
		);
		return makeToolResult(
			finalDetails,
			`Parallel: ${success}/${records.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
		);
	}
	const record = records[0];
	return makeToolResult(finalDetails, record ? resultText(record) : "(no output)");
}

function laneStatusFromDetails(details: StepSubagentDetails): BackgroundAgentLane["status"] {
	if (details.results.some((record) => record.status === "running")) {
		return "running";
	}
	if (details.results.some((record) => record.status === "failed")) {
		return "failed";
	}
	if (details.results.some((record) => record.status === "aborted")) {
		return "aborted";
	}
	return "completed";
}

function laneMatches(
	lane: BackgroundAgentLane,
	selector: {
		agentId?: string;
		agent_id?: string;
		alias?: string;
		group?: string;
	},
): boolean {
	const agentId = selector.agentId ?? selector.agent_id;
	if (agentId) return lane.id === agentId;
	if (selector.alias) return lane.alias === selector.alias;
	if (selector.group) return lane.group === selector.group;
	return true;
}

function laneSummary(lane: BackgroundAgentLane): string {
	const output = lane.result?.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	const label = lane.alias ? ` ${lane.alias}` : "";
	return `${lane.id}${label}: ${lane.status}${output ? `\n${truncateText(output, 2_000)}` : ""}`;
}

function laneWidgetLines(lane: BackgroundAgentLane): string[] {
	const records = lane.details.results;
	const lines = [
		`agent ${lane.id} ${lane.status}`,
		...records.map((record) => {
			const live = record.activeTool
				? ` | ${record.activeTool}`
				: record.activeText
					? ` | ${record.activeText.split(/\r?\n/u).at(-1)?.slice(0, 100) ?? ""}`
					: "";
			return `${statusIcon(record.status, themeForWidget)} ${record.agent}${live}`;
		}),
	];
	return lines;
}

// Widgets receive the same color callback shape as the native renderer. Keep
// this tiny fallback local so background lanes can also be shown in test hosts.
const themeForWidget = {
	fg: (_color: string, text: string): string => text,
} as unknown as Theme;

const AgentSelectorSchema = Type.Object({
	agent_id: Type.Optional(Type.String({ description: "Background agent id" })),
	alias: Type.Optional(Type.String({ description: "Background agent alias" })),
	group: Type.Optional(Type.String({ description: "Background agent group" })),
});

const AgentReplySchema = Type.Object({
	agent_id: Type.Optional(Type.String({ description: "Background agent id" })),
	alias: Type.Optional(Type.String({ description: "Background agent alias" })),
	prompt: Type.String({ description: "Follow-up instruction" }),
	interrupt: Type.Optional(Type.Boolean({ description: "Interrupt the current turn first" })),
});

const AgentWaitSchema = Type.Object({
	agent_id: Type.Optional(Type.String({ description: "Background agent id" })),
	alias: Type.Optional(Type.String({ description: "Background agent alias" })),
	group: Type.Optional(Type.String({ description: "Background agent group" })),
	wait_for: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all"), Type.Literal("first_ready")])),
	wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 120_000 })),
});

type AgentSelector = Static<typeof AgentSelectorSchema>;

function controlResult(text: string): AgentToolResult<undefined>;
function controlResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails>;
function controlResult<TDetails>(text: string, details?: TDetails): AgentToolResult<TDetails | undefined> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

/** Construct the hidden inline extension used by the Step launcher. */
export function createStepSubagentExtension(options: StepSubagentExtensionOptions = {}): ExtensionFactory {
	const resolved = {
		agentDir: path.resolve(options.agentDir ?? resolveStepAgentDir()),
		configDirName: options.configDirName?.trim() || resolveStepConfigDir() || CONFIG_DIR_NAME,
		includeBuiltinAgents: options.includeBuiltinAgents !== false,
		maxParallelTasks: Math.max(1, Math.min(MAX_PARALLEL_TASKS, options.maxParallelTasks ?? MAX_PARALLEL_TASKS)),
		maxConcurrency: Math.max(
			1,
			Math.min(options.maxConcurrency ?? DEFAULT_CONCURRENCY, options.maxParallelTasks ?? MAX_PARALLEL_TASKS),
		),
		telemetry: options.telemetry,
		worktreeManager: options.worktreeManager ?? {
			allocate: allocateStepWorktree,
		},
		runner: options.runner ?? runStepSubagentProcess,
	};
	return (pi: ExtensionAPI): void => {
		// The child process inherits this marker. It still gets Step's provider and
		// tool profile, but does not recursively expose another subagent tool.
		if (process.env[CHILD_MARKER] === "1") return;

		const lanes = new Map<string, BackgroundAgentLane>();
		const laneWidgetKey = (id: string): string => `step-agent:${id}`;
		const updateLaneWidget = (lane: BackgroundAgentLane): void => {
			if (!lane.ctx.hasUI) return;
			try {
				lane.ctx.ui.setWidget(laneWidgetKey(lane.id), laneWidgetLines(lane), {
					placement: "aboveEditor",
				});
			} catch {
				// A host may tear down its UI while a detached child is finishing.
			}
		};
		const startLane = (lane: BackgroundAgentLane, params: SubagentParams): void => {
			const generation = lane.runGeneration + 1;
			lane.runGeneration = generation;
			lane.controller = new AbortController();
			lane.status = "running";
			lane.updatedAt = Date.now();
			const runParams = { ...params, run_in_background: undefined };
			const onUpdate = (partial: AgentToolResult<StepSubagentDetails>): void => {
				if (lane.runGeneration !== generation) return;
				if (partial.details) {
					lane.details = {
						...partial.details,
						agentId: lane.id,
						status: "running",
						startedAt: lane.startedAt,
						updatedAt: Date.now(),
					};
					lane.updatedAt = Date.now();
				}
				updateLaneWidget(lane);
			};
			const promise = executeSubagent(runParams, lane.controller.signal, onUpdate, lane.ctx, resolved);
			lane.promise = promise;
			void promise
				.then((result) => {
					if (lane.runGeneration !== generation) return;
					lane.result = result;
					lane.details = {
						...(result.details ?? lane.details),
						agentId: lane.id,
						status: result.details ? laneStatusFromDetails(result.details) : "completed",
						startedAt: lane.startedAt,
						updatedAt: Date.now(),
					};
					lane.status = lane.details.status ?? "completed";
					lane.updatedAt = Date.now();
					updateLaneWidget(lane);
					const next = lane.queuedPrompts.shift();
					if (next && lane.status !== "aborted") {
						startLane(lane, { ...lane.params, task: next, run_in_background: undefined });
					}
				})
				.catch((error: unknown) => {
					if (lane.runGeneration !== generation) return;
					lane.status = "failed";
					lane.updatedAt = Date.now();
					lane.result = controlResult(
						`Background agent ${lane.id} failed: ${error instanceof Error ? error.message : String(error)}`,
						lane.details,
					);
					updateLaneWidget(lane);
				});
		};
		const createLane = (params: SubagentParams, ctx: ExtensionContext): BackgroundAgentLane => {
			const id = randomUUID().slice(0, 8);
			const now = Date.now();
			const mode: StepSubagentDetails["mode"] =
				(params.chain?.length ?? 0) > 0 ? "chain" : (params.tasks?.length ?? 0) > 0 ? "parallel" : "single";
			const details: StepSubagentDetails = {
				mode,
				agentScope: params.agentScope ?? "user",
				userAgentsDir: path.join(resolved.agentDir, "agents"),
				projectAgentsDir: null,
				results: [],
				agentId: id,
				status: "running",
				startedAt: now,
				updatedAt: now,
			};
			const lane = {
				id,
				...(params.alias?.trim() ? { alias: params.alias.trim() } : {}),
				...(params.group?.trim() ? { group: params.group.trim() } : {}),
				params,
				ctx,
				controller: new AbortController(),
				status: "running" as const,
				details,
				promise: Promise.resolve(controlResult("pending", details)),
				queuedPrompts: [],
				startedAt: now,
				updatedAt: now,
				runGeneration: 0,
			} satisfies BackgroundAgentLane;
			lanes.set(id, lane);
			return lane;
		};
		const findLane = (selector: AgentSelector): BackgroundAgentLane | undefined => {
			const candidates = [...lanes.values()].filter((lane) => laneMatches(lane, selector));
			return candidates[0];
		};

		pi.registerTool<typeof StepSubagentParamsSchema, StepSubagentDetails>({
			name: "subagent",
			label: "Subagent",
			description: [
				"Delegate tasks to specialized subagents with isolated context.",
				"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
				`Default agent scope is "user" (from ${path.join(resolved.agentDir, "agents")}).`,
				`To enable project-local agents in ${resolved.configDirName}/agents, set agentScope: "both" (or "project").`,
			].join(" "),
			parameters: StepSubagentParamsSchema,
			execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
				// Background lanes remain available to embedded Step callers through
				// the internal extension API, while ordinary model calls follow Pi's
				// blocking single/parallel/chain contract.
				if ((params as SubagentParams).run_in_background) {
					const lane = createLane(params as SubagentParams, ctx);
					startLane(lane, params as SubagentParams);
					const details: StepSubagentDetails = {
						...lane.details,
						results: [...lane.details.results],
					};
					return makeToolResult(
						details,
						`Started background agent ${lane.id}${lane.alias ? ` (${lane.alias})` : ""}. Use agent_wait or agent_list to monitor it.`,
					);
				}
				return executeSubagent(params as SubagentParams, signal, onUpdate, ctx, resolved);
			},
			renderCall: (params, theme) => {
				if (params.chain && params.chain.length > 0) {
					return new Text(
						`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `chain (${params.chain.length} steps)`)}\n  ${theme.fg("dim", params.chain[0]?.task ?? "...")}`,
						0,
						0,
					);
				}
				if (params.tasks && params.tasks.length > 0) {
					return new Text(
						`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${params.tasks.length} tasks)`)}\n  ${theme.fg("dim", params.tasks[0]?.task ?? "...")}`,
						0,
						0,
					);
				}
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", params.agent ?? "...")}\n  ${theme.fg("dim", params.task ?? "...")}`,
					0,
					0,
				);
			},
			renderResult: (result, renderOptions, theme) => renderSubagentResult(result, renderOptions, theme),
		});

		pi.registerTool<typeof AgentReplySchema>({
			name: "agent_reply",
			label: "Agent reply",
			description: "Send a follow-up prompt to a background lane created by agent with run_in_background=true.",
			parameters: AgentReplySchema,
			executionMode: "sequential",
			execute: async (_id, params) => {
				const lane = findLane(params);
				if (!lane) return controlResult("agent_reply: no matching background agent");
				const prompt = params.prompt.trim();
				if (!prompt) return controlResult("agent_reply: prompt must not be empty");
				if (lane.status === "running" && params.interrupt !== true) {
					lane.queuedPrompts.push(prompt);
					return controlResult(`Queued follow-up for agent ${lane.id}`);
				}
				if (lane.status === "running") lane.controller.abort();
				if (params.interrupt === true) lane.queuedPrompts.length = 0;
				startLane(lane, {
					...lane.params,
					task: prompt,
					run_in_background: undefined,
				});
				return controlResult(`Started follow-up for agent ${lane.id}`, lane.details);
			},
		});

		pi.registerTool<typeof AgentWaitSchema>({
			name: "agent_wait",
			label: "Agent wait",
			description:
				"Wait for updates from background lanes created by agent. Select one lane with agent_id or alias, a group, or omit selectors to wait across all lanes.",
			parameters: AgentWaitSchema,
			executionMode: "sequential",
			execute: async (_id, params, signal) => {
				const selected = [...lanes.values()].filter((lane) => laneMatches(lane, params));
				if (selected.length === 0) return controlResult("No matching background agents");
				const waitFor = params.wait_for ?? "any";
				const waitMs = params.wait_ms ?? 30_000;
				const pending = selected.filter((lane) => lane.status === "running");
				if (pending.length > 0) {
					const waitPromise =
						waitFor === "all"
							? Promise.all(pending.map((lane) => lane.promise))
							: Promise.race(pending.map((lane) => lane.promise));
					await Promise.race([
						waitPromise,
						new Promise<void>((resolveWait) => setTimeout(resolveWait, waitMs)),
						new Promise<void>((_, rejectWait) => {
							if (signal?.aborted) rejectWait(new Error("agent_wait aborted"));
							else
								signal?.addEventListener("abort", () => rejectWait(new Error("agent_wait aborted")), {
									once: true,
								});
						}),
					]).catch(() => undefined);
				}
				return controlResult(
					selected.map(laneSummary).join("\n\n"),
					selected.map((lane) => lane.details),
				);
			},
		});

		pi.registerTool<typeof AgentSelectorSchema>({
			name: "agent_interrupt",
			label: "Agent interrupt",
			description: "Interrupt a running background lane created by agent.",
			parameters: AgentSelectorSchema,
			executionMode: "sequential",
			execute: async (_id, params) => {
				const lane = findLane(params);
				if (!lane) return controlResult("agent_interrupt: no matching background agent");
				if (lane.status !== "running") return controlResult(`Agent ${lane.id} is already ${lane.status}`);
				lane.queuedPrompts.length = 0;
				lane.runGeneration += 1;
				lane.controller.abort();
				lane.status = "aborted";
				lane.updatedAt = Date.now();
				updateLaneWidget(lane);
				return controlResult(`Interrupted agent ${lane.id}`, lane.details);
			},
		});

		pi.registerTool<typeof AgentSelectorSchema>({
			name: "agent_list",
			label: "Agent list",
			description: "List background lanes created by agent with their status, live step, and output preview.",
			parameters: AgentSelectorSchema,
			executionMode: "sequential",
			execute: async (_id, params) => {
				const selected = [...lanes.values()].filter((lane) => laneMatches(lane, params));
				return controlResult(
					selected.length > 0 ? selected.map(laneSummary).join("\n\n") : "No background agents",
					selected.map((lane) => lane.details),
				);
			},
		});
	};
}

export const stepSubagentExtensionInline: InlineExtension = {
	name: "Step subagent",
	factory: createStepSubagentExtension(),
	hidden: true,
};
