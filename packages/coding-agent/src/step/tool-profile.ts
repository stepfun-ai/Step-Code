/**
 * Step's model-facing tool contract.
 *
 * The runtime remains Pi's native AgentSession/agent loop.  These definitions
 * only change the public name, schema, and argument vocabulary; execution and
 * rendering are delegated to the corresponding Pi tool whenever the contracts
 * are equivalent.
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir as fsMkdir, readdir as fsReaddir, stat as fsStat, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@step-harness/agent-core";
import type { Component } from "@step-harness/pi-tui";
import { type Static, Type } from "typebox";
import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "../core/extensions/types.ts";
import type { EditToolOptions } from "../core/tools/edit.ts";
import { generateDiffString, generateUnifiedPatch, normalizeToLF } from "../core/tools/edit-diff.ts";
import { withFileMutationQueue } from "../core/tools/file-mutation-queue.ts";
import type { FindToolOptions } from "../core/tools/find.ts";
import type { GrepToolOptions } from "../core/tools/grep.ts";
import {
	type BashToolOptions,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type LsOperations,
	type WriteToolInput,
} from "../core/tools/index.ts";
import type { LsToolOptions } from "../core/tools/ls.ts";
import { pathExists, resolveReadPathAsync, resolveToCwd } from "../core/tools/path-utils.ts";
import type { ReadToolOptions } from "../core/tools/read.ts";
import type { WriteToolOptions } from "../core/tools/write.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";
import { resolvePath } from "../utils/paths.ts";
import {
	getShellConfig,
	getShellEnv,
	spawnShellChild,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../utils/shell.ts";
import { resolveStepAgentDir } from "./environment.ts";
import { createSearchWebTool, type SearchWebToolOptions } from "./search-web-tool.ts";

const STEP_TOOL_NAMES = [
	"list_directory",
	"find_files",
	"search_files",
	"search_web",
	"read_file",
	"write_file",
	"edit_file",
	"run_command",
	"find_tools",
] as const;

export type StepToolName = (typeof STEP_TOOL_NAMES)[number];

export const stepToolNames: readonly StepToolName[] = STEP_TOOL_NAMES;

const STEP_NATIVE_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);

const PATH_DESCRIPTION =
	"Relative paths resolve from the initial working directory; absolute paths and ~/ home paths are accepted.";
const RUN_COMMAND_CWD_DESCRIPTION = `Working directory. ${PATH_DESCRIPTION}`;
const READ_FILE_DESCRIPTION =
	"Read a text file with optional line range; image files (PNG/JPEG/GIF/WebP) are returned as attached images. Prefer this over shell cat for token efficiency.";
const WRITE_FILE_DESCRIPTION =
	"Write full content to a file, creating parent directories if missing. Overwrites existing content — for existing files prefer edit_file.";

const listDirectorySchema = Type.Object({
	path: Type.Optional(Type.String({ description: `Directory path. ${PATH_DESCRIPTION} Defaults to '.'` })),
	max_entries: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum entries to return" })),
	include_hidden: Type.Optional(Type.Boolean({ description: "Include dotfiles and hidden directories" })),
});

const findFilesSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern, e.g. 'src/**/*.ts'" }),
	path: Type.Optional(Type.String({ description: `Directory to search from. ${PATH_DESCRIPTION} Defaults to '.'` })),
	max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum files to return" })),
});

const searchFilesSchema = Type.Object({
	pattern: Type.String({ description: "Regular expression to search for" }),
	path: Type.Optional(
		Type.String({ description: `Directory or file to search. ${PATH_DESCRIPTION} Defaults to '.'` }),
	),
	glob: Type.Optional(Type.String({ description: "Optional glob filter on file names, e.g. '*.ts'" })),
	context_lines: Type.Optional(
		Type.Integer({ minimum: 0, maximum: 10, description: "Lines of context around each match" }),
	),
	max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum matches to return" })),
});

const readFileSchema = Type.Object({
	path: Type.String({ description: `File path. ${PATH_DESCRIPTION}` }),
	start_line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based start line" })),
	end_line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based end line" })),
	max_chars: Type.Optional(Type.Integer({ minimum: 200, maximum: 120000, description: "Max returned characters" })),
});

const writeFileSchema = Type.Object({
	path: Type.String({ description: `File path. ${PATH_DESCRIPTION}` }),
	content: Type.String({ description: "Full file content" }),
});

const editFileSchema = Type.Object({
	path: Type.String({ description: `File path. ${PATH_DESCRIPTION}` }),
	search: Type.String({ description: "Literal string to find" }),
	replace: Type.String({ description: "Replacement string" }),
	replace_all: Type.Optional(Type.Boolean({ description: "Replace all matches" })),
});

const runCommandSchema = Type.Object({
	command: Type.String({ description: "Shell command string" }),
	cwd: Type.Optional(Type.String({ description: RUN_COMMAND_CWD_DESCRIPTION })),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600000 })),
	max_output_chars: Type.Optional(
		Type.Integer({ minimum: 200, maximum: 120000, description: "Output character cap for stdout+stderr" }),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Start the command detached and return immediately with its pid and a log file capturing stdout+stderr. Use for long-running processes such as dev servers: read the log to confirm readiness, then stop it (and the processes it spawned) with the kill command returned in the result. The process is terminated when the session exits; timeout_ms and max_output_chars do not apply.",
		}),
	),
});

const findToolsSchema = Type.Object({
	query: Type.String({ description: "Natural-language description of the tool you need" }),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 20, description: "Maximum number of matching tools to return" }),
	),
});

type ListDirectoryInput = Static<typeof listDirectorySchema>;
type FindFilesInput = Static<typeof findFilesSchema>;
type SearchFilesInput = Static<typeof searchFilesSchema>;
type ReadFileInput = Static<typeof readFileSchema>;
type WriteFileInput = Static<typeof writeFileSchema>;
type EditFileInput = Static<typeof editFileSchema>;
type RunCommandInput = Static<typeof runCommandSchema>;
type FindToolsInput = Static<typeof findToolsSchema>;

export interface StepToolProfileOptions {
	/** Step agent directory used by native find/grep/bash managed binaries. */
	agentDir?: string;
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	edit?: EditToolOptions;
	find?: FindToolOptions;
	grep?: GrepToolOptions;
	ls?: LsToolOptions;
	write?: WriteToolOptions;
	searchWeb?: SearchWebToolOptions;
}

type AnyResult = AgentToolResult<any>;
type AnyToolDefinition = ToolDefinition<any, any, any>;

/** The Step tools intentionally use a smaller, character-oriented cap than Pi's byte cap. */
const DEFAULT_STEP_MAX_CHARS = 24_000;
const MIN_STEP_MAX_CHARS = 200;
const MAX_STEP_MAX_CHARS = 120_000;
const FIND_TIMEOUT_MS = 5_000;
const SEARCH_TIMEOUT_MS = 10_000;
const NATIVE_FIND_LIMIT = 5_000;
const SEARCH_MAX_LINE_LENGTH = 8_192;
const SEARCH_MAX_RENDERED_LINE_CHARS = 400;
const MIN_COMMAND_TIMEOUT_MS = 1_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
const MIN_COMMAND_OUTPUT_CHARS = 200;
const MAX_COMMAND_OUTPUT_CHARS = 120_000;

const STEP_TRUNCATION_HINTS = {
	find_files: {
		banner: "WARNING: find_files output is truncated. This is not the full match list.",
		continuation: "To continue, narrow the pattern or path and call find_files again.",
	},
	read_file: {
		banner: "WARNING: read_file output is truncated. This is not the full file content.",
		continuation: "To continue, narrow start_line/end_line or increase max_chars and call read_file again.",
	},
	run_command: {
		banner: "WARNING: run_command output is truncated. This is not the full command output.",
		continuation: "To continue, narrow the command output or increase max_output_chars and call run_command again.",
	},
	search_files: {
		banner: "WARNING: search_files output is truncated. This is not the full match list.",
		continuation:
			"To continue, narrow the pattern, add a glob filter, lower context_lines, or call search_files again on a narrower path.",
	},
} as const;

type StepTruncationToolName = keyof typeof STEP_TRUNCATION_HINTS;

function getContextValue<T>(ctx: ExtensionContext | undefined, key: string): T | undefined {
	return ctx && typeof ctx === "object"
		? ((ctx as unknown as Record<string, unknown>)[key] as T | undefined)
		: undefined;
}

function getToolCwd(ctx: ExtensionContext | undefined, fallback: string): string {
	return getContextValue<string>(ctx, "cwd") ?? fallback;
}

function getContextOutputLimit(ctx: ExtensionContext | undefined): number | undefined {
	const limit = getContextValue<number>(ctx, "commandOutputLimit");
	return typeof limit === "number" && Number.isFinite(limit) ? limit : undefined;
}

function resolveStepMaxChars(requested: number | undefined, ctx: ExtensionContext | undefined): number {
	const configured = getContextOutputLimit(ctx);
	const upperBound = configured === undefined ? MAX_STEP_MAX_CHARS : Math.max(MIN_STEP_MAX_CHARS, configured * 2);
	return Math.max(MIN_STEP_MAX_CHARS, Math.min(MAX_STEP_MAX_CHARS, requested ?? DEFAULT_STEP_MAX_CHARS, upperBound));
}

function textFromResult(result: AnyResult): string {
	return result.content
		.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

function withStepTextLimit(
	toolName: StepTruncationToolName,
	text: string,
	maxChars: number,
): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	const hint = STEP_TRUNCATION_HINTS[toolName];
	const compatibilitySuffix = toolName === "read_file" ? `\n\n[Output truncated to ${maxChars} characters.]` : "";
	const prefix = `${hint.banner}\n${hint.continuation}\n\n`;
	if (prefix.length + compatibilitySuffix.length >= maxChars) {
		return { text: `${prefix}${compatibilitySuffix}`, truncated: true };
	}
	const remaining = maxChars - prefix.length - compatibilitySuffix.length;
	// Keep both ends: diagnostics and command output often put the useful part at EOF.
	const head = Math.ceil(remaining * 0.7);
	const tail = Math.max(0, remaining - head);
	const body = tail > 0 ? `${text.slice(0, head)}\n...\n${text.slice(-tail)}` : text.slice(0, head);
	return { text: `${prefix}${body}${compatibilitySuffix}`, truncated: true };
}

/** Preserve the historical read_file suffix used by clients that display caps verbatim. */
function withReadTextLimit(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return {
		text: `${text.slice(0, maxChars)}\n\n[Output truncated to ${maxChars} characters.]`,
		truncated: true,
	};
}

function applyStepTextLimit(result: AnyResult, toolName: StepTruncationToolName, maxChars: number): AnyResult {
	const text = textFromResult(result);
	const limited = withStepTextLimit(toolName, text, maxChars);
	if (!limited.truncated) return result;
	return {
		...result,
		content: [{ type: "text", text: limited.text }],
		details: {
			...(result.details && typeof result.details === "object" ? result.details : {}),
			stepTruncated: true,
		},
	} as AnyResult;
}

function splitTextFileLines(content: string): string[] {
	const lines = content.split(/\r?\n/u);
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	return lines;
}

function isCallerAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/** Run a native Pi tool with a bounded Step deadline while preserving caller cancellation. */
async function executeNativeWithTimeout(
	native: AnyToolDefinition,
	toolCallId: string,
	args: unknown,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<any> | undefined,
	ctx: ExtensionContext | undefined,
	timeoutMs: number,
): Promise<{ result?: AnyResult; timedOut: boolean }> {
	if (isCallerAborted(signal)) throw new Error("Operation aborted");
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	let raceTimer: ReturnType<typeof setTimeout> | undefined;
	let execution: Promise<AnyResult> | undefined;
	try {
		// Keep synchronous validation failures inside the cleanup boundary too.
		execution = Promise.resolve(
			native.execute(toolCallId, args, controller.signal, onUpdate, ctx as ExtensionContext),
		);
		const result = await Promise.race([
			execution,
			new Promise<AnyResult | undefined>((resolve) => {
				raceTimer = setTimeout(() => resolve(undefined), timeoutMs);
			}),
		]);
		if (result === undefined) {
			timedOut = true;
			controller.abort();
			void execution.catch(() => undefined);
			return { timedOut: true };
		}
		return { result, timedOut };
	} catch (error) {
		if (timedOut && !isCallerAborted(signal)) {
			void execution?.catch(() => undefined);
			return { timedOut: true };
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		if (raceTimer !== undefined) clearTimeout(raceTimer);
		signal?.removeEventListener("abort", onAbort);
	}
}
type Renderer<TArgs = any, TState = any> = {
	renderCall?: (args: TArgs, theme: any, context: ToolRenderContext<TState, TArgs>) => Component;
	renderResult?: (
		result: AnyResult,
		options: ToolRenderResultOptions,
		theme: any,
		context: ToolRenderContext<TState, TArgs>,
	) => Component;
};

/** Keep the underlying Pi component/state while changing only its visible title. */
class RenamedRendererComponent implements Component {
	readonly wantsKeyRelease?: boolean;
	readonly inner: Component;
	readonly from: string;
	readonly to: string;

	constructor(inner: Component, from: string, to: string) {
		this.inner = inner;
		this.from = from;
		this.to = to;
		this.wantsKeyRelease = inner.wantsKeyRelease;
	}

	render(width: number): string[] {
		let replaced = false;
		return this.inner.render(width).map((line) => {
			if (replaced) return line;
			const index = line.indexOf(this.from);
			if (index < 0) return line;
			replaced = true;
			return `${line.slice(0, index)}${this.to}${line.slice(index + this.from.length)}`;
		});
	}

	handleInput(data: string): void {
		this.inner.handleInput?.(data);
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

function unwrapRendererComponent(component: Component | undefined): Component | undefined {
	return component instanceof RenamedRendererComponent ? component.inner : component;
}

function renameRendererComponent(component: Component, from: string, to: string): Component {
	return from === to ? component : new RenamedRendererComponent(component, from, to);
}

/** Keep renderer state/context native while presenting Step-shaped arguments. */
function aliasDefinition<
	TStepSchema extends ReturnType<typeof Type.Object>,
	TNativeArgs,
	TDetails = unknown,
	TState = any,
>(
	step: {
		name: StepToolName;
		label: string;
		description: string;
		promptSnippet: string;
		promptGuidelines?: string[];
		parameters: TStepSchema;
	},
	native: ToolDefinition<any, TDetails, TState>,
	mapArgs: (args: any) => TNativeArgs,
): ToolDefinition<TStepSchema, TDetails, TState> {
	const renderer = native as Renderer<TNativeArgs, TState>;
	return {
		name: step.name,
		label: step.label,
		description: step.description,
		promptSnippet: step.promptSnippet,
		promptGuidelines: step.promptGuidelines,
		parameters: step.parameters,
		constrainedSampling: native.constrainedSampling,
		executionMode: native.executionMode,
		renderShell: native.renderShell,
		execute: (toolCallId, args, signal, onUpdate, ctx) =>
			native.execute(toolCallId, mapArgs(args), signal, onUpdate, ctx),
		renderCall: renderer.renderCall
			? (args, theme, context) =>
					renameRendererComponent(
						renderer.renderCall!(mapArgs(args), theme, {
							...context,
							lastComponent: unwrapRendererComponent(context.lastComponent),
							args: mapArgs(args),
						}),
						native.name,
						step.name,
					)
			: undefined,
		renderResult: renderer.renderResult
			? (result, options, theme, context) =>
					renameRendererComponent(
						renderer.renderResult!(result, options, theme, {
							...context,
							lastComponent: unwrapRendererComponent(context.lastComponent),
							args: mapArgs(context.args),
						}),
						native.name,
						step.name,
					)
			: undefined,
	};
}

function mapListDirectoryArgs(args: ListDirectoryInput): { path?: string; limit?: number } {
	return { path: args.path, limit: args.max_entries };
}

type DirectoryEntry = { name: string; kind: "dir" | "link" | "file" };

/** Execute the Step directory contract (hidden filtering and directory-first order). */
async function executeListDirectory(
	args: ListDirectoryInput,
	cwd: string,
	operations: LsOperations | undefined,
	signal: AbortSignal | undefined,
): Promise<AnyResult> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const target = args.path ?? ".";
	const absolute = resolveToCwd(target, cwd);
	const ops = operations ?? {
		exists: pathExists,
		stat: fsStat,
		readdir: async (path: string) =>
			(await fsReaddir(path, { withFileTypes: true })).map((entry) =>
				entry.isDirectory() ? `${entry.name}/` : entry.isSymbolicLink() ? `${entry.name}@` : entry.name,
			),
	};
	if (!(await ops.exists(absolute))) throw new Error(`Path not found: ${absolute}`);
	const stat = await ops.stat(absolute);
	if (!stat.isDirectory()) throw new Error(`Not a directory: ${absolute}`);
	const rawEntries = await ops.readdir(absolute);
	const includeHidden = args.include_hidden ?? false;
	const entries: DirectoryEntry[] = rawEntries
		.filter((entry) => includeHidden || !entry.replace(/[/@]$/u, "").startsWith("."))
		.map((entry) => {
			if (entry.endsWith("/")) return { name: entry.slice(0, -1), kind: "dir" as const };
			if (entry.endsWith("@")) return { name: entry.slice(0, -1), kind: "link" as const };
			return { name: entry, kind: "file" as const };
		});
	entries.sort((left, right) => {
		const leftRank = left.kind === "dir" ? 0 : 1;
		const rightRank = right.kind === "dir" ? 0 : 1;
		return leftRank - rightRank || left.name.localeCompare(right.name);
	});
	const maxEntries = Math.max(1, Math.min(1000, args.max_entries ?? 200));
	const selected = entries.slice(0, maxEntries);
	const lines = selected.map(
		(entry) =>
			`${entry.kind === "dir" ? "dir" : entry.kind === "link" ? "link" : "file"} ${entry.name}${entry.kind === "dir" ? "/" : entry.kind === "link" ? "@" : ""}`,
	);
	const truncated = entries.length > selected.length;
	if (truncated) lines.push(`... (${entries.length - selected.length} more entries)`);
	return {
		content: [{ type: "text", text: lines.join("\n") || "(empty directory)" }],
		details: {
			path: target,
			returnedEntries: selected.length,
			totalEntries: entries.length,
			directories: entries.filter((entry) => entry.kind === "dir").length,
			files: entries.filter((entry) => entry.kind !== "dir").length,
			truncated,
			...(truncated ? { entryLimitReached: selected.length } : {}),
		},
	};
}

function mapFindFilesArgs(args: FindFilesInput): { pattern: string; path?: string; limit?: number } {
	return { pattern: args.pattern, path: args.path, limit: args.max_results ?? 100 };
}

function mapSearchFilesArgs(args: SearchFilesInput): {
	pattern: string;
	path?: string;
	glob?: string;
	context?: number;
	limit?: number;
} {
	return {
		pattern: args.pattern,
		path: args.path,
		glob: args.glob,
		context: args.context_lines,
		limit: args.max_results,
	};
}

function nativeDetails(result: AnyResult): Record<string, unknown> {
	return result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {};
}

function stripNativeFindNotices(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) =>
				line.length > 0 &&
				line !== "No files found matching pattern" &&
				!line.startsWith("[") &&
				!line.startsWith("WARNING:"),
		);
}

function resolveNativePath(display: string, searchRoot: string): string {
	return path.isAbsolute(display) ? display : path.resolve(searchRoot, display);
}

/** Split an absolute glob so fd searches from its literal directory prefix. */
function splitAbsolutePattern(pattern: string): { directory: string; pattern: string } | undefined {
	if (!path.isAbsolute(pattern)) return undefined;
	const wildcard = pattern.search(/[*?[{]/u);
	if (wildcard < 0) {
		return { directory: path.dirname(pattern), pattern: path.basename(pattern) };
	}
	const separator = pattern.lastIndexOf("/", wildcard);
	if (separator < 0) return undefined;
	const directory = pattern.slice(0, separator) || path.parse(pattern).root;
	return { directory, pattern: pattern.slice(separator + 1) || "*" };
}

async function executeFindFiles(
	native: AnyToolDefinition,
	args: FindFilesInput,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<any> | undefined,
	ctx: ExtensionContext | undefined,
): Promise<AnyResult> {
	const effectiveCwd = getToolCwd(ctx, cwd);
	const requestedLimit = Math.max(1, Math.min(1_000, args.max_results ?? 100));
	const absoluteScope = splitAbsolutePattern(args.pattern);
	// Ask Pi for a broad set before applying the Step limit, otherwise sorting
	// only the first native page can put an older file ahead of a newer one.
	const nativeArgs = {
		pattern: absoluteScope?.pattern ?? args.pattern,
		path: absoluteScope?.directory ?? args.path,
		limit: Math.max(NATIVE_FIND_LIMIT, requestedLimit),
	};
	const timeoutMs = getContextValue<number>(ctx, "toolTimeoutMs") ?? FIND_TIMEOUT_MS;
	const execution = await executeNativeWithTimeout(
		native,
		"step-find-files",
		nativeArgs,
		signal,
		onUpdate,
		ctx,
		Math.max(1, timeoutMs),
	);
	if (execution.timedOut || !execution.result) {
		return {
			content: [{ type: "text", text: "WARNING: find_files scan timed out before all matches were collected." }],
			details: { timedOut: true, stepTruncated: true },
		} as AnyResult;
	}

	const result = execution.result;
	const rawPaths = stripNativeFindNotices(textFromResult(result));
	const searchRoot = resolveToCwd(nativeArgs.path ?? ".", effectiveCwd);
	const ranked = await Promise.all(
		rawPaths.map(async (display) => {
			const prefixedDisplay =
				absoluteScope && !path.isAbsolute(display) ? path.join(absoluteScope.directory, display) : display;
			let mtimeMs = 0;
			try {
				mtimeMs = (await fsStat(resolveNativePath(display, searchRoot))).mtimeMs;
			} catch {
				// A file can disappear between fd output and stat; keep it in the
				// deterministic tail rather than dropping an otherwise valid match.
			}
			return { display: prefixedDisplay.split(path.sep).join("/"), mtimeMs };
		}),
	);
	ranked.sort((left, right) => right.mtimeMs - left.mtimeMs || left.display.localeCompare(right.display, "en"));
	const returned = ranked.slice(0, requestedLimit).map((entry) => entry.display);
	const details = nativeDetails(result);
	const nativeCapped = typeof details.resultLimitReached === "number" || details.truncation !== undefined;
	const truncated = nativeCapped || ranked.length > returned.length;
	const maxChars = resolveStepMaxChars(undefined, ctx);
	const limited = withStepTextLimit("find_files", returned.join("\n") || "(no matches)", maxChars);
	return {
		...result,
		content: [{ type: "text", text: limited.text }],
		details: {
			...details,
			...(ranked.length > returned.length && details.resultLimitReached === undefined
				? { resultLimitReached: requestedLimit }
				: {}),
			matchedFiles: ranked.length,
			returnedFiles: returned.length,
			truncated: truncated || limited.truncated,
			timedOut: false,
			stepTruncated: limited.truncated,
		},
	} as AnyResult;
}

type SearchRow = { display: string; line: number; text: string };

function parseNativeSearchRows(text: string): SearchRow[] {
	const rows: SearchRow[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trimEnd();
		// Match the row shape, not a prefix: "[" and "WARNING:" can start valid paths.
		const match = /^(.*):(\d+): (.*)$/u.exec(line);
		if (match) {
			rows.push({ display: match[1] ?? "", line: Number(match[2]), text: match[3] ?? "" });
		}
	}
	return rows.filter((row) => row.display.length > 0 && Number.isFinite(row.line));
}

function shortenSearchLine(line: string): string {
	const normalized = line.replace(/\r$/u, "");
	return normalized.length <= SEARCH_MAX_RENDERED_LINE_CHARS
		? normalized
		: `${normalized.slice(0, SEARCH_MAX_RENDERED_LINE_CHARS)}...`;
}

function renderSearchBlocks(
	rows: readonly SearchRow[],
	files: ReadonlyMap<string, string[]>,
	contextLines: number,
): { text: string; matches: number; filesMatched: number } {
	const blocks: Array<{ display: string; start: number; end: number; lines: string[] }> = [];
	const accepted = new Set<string>();
	for (const row of rows) {
		const sourceLines = files.get(row.display);
		const sourceLine = sourceLines?.[row.line - 1];
		// Pi's rg renderer shortens long lines, but Step deliberately skips them
		// so a binary/generated blob cannot dominate the model context.
		if (sourceLine !== undefined && sourceLine.length > SEARCH_MAX_LINE_LENGTH) continue;
		if (!sourceLines) {
			const previous = blocks.at(-1);
			if (previous && previous.display === row.display && previous.end + 1 === row.line) {
				previous.lines.push(`${row.display}:${row.line}: ${shortenSearchLine(row.text)}`);
				previous.end = row.line;
			} else {
				blocks.push({
					display: row.display,
					start: row.line,
					end: row.line,
					lines: [`${row.display}:${row.line}: ${shortenSearchLine(row.text)}`],
				});
			}
			accepted.add(`${row.display}:${row.line}`);
			continue;
		}
		const lines = sourceLines;
		const start = Math.max(1, row.line - contextLines);
		const end = Math.min(lines.length, row.line + contextLines);
		const blockLines: string[] = [];
		for (let number = start; number <= end; number += 1) {
			const lineText = shortenSearchLine(lines[number - 1] ?? (number === row.line ? row.text : ""));
			blockLines.push(`${row.display}:${number}${number === row.line ? ":" : "-"} ${lineText}`);
		}
		const previous = blocks.at(-1);
		if (previous && previous.display === row.display && start <= previous.end + 1) {
			for (let number = Math.max(previous.end + 1, start); number <= end; number += 1) {
				const lineText = shortenSearchLine(lines[number - 1] ?? "");
				previous.lines.push(`${row.display}:${number}${number === row.line ? ":" : "-"} ${lineText}`);
			}
			previous.end = Math.max(previous.end, end);
		} else {
			blocks.push({ display: row.display, start, end, lines: blockLines });
		}
		accepted.add(`${row.display}:${row.line}`);
	}
	return {
		text: blocks.map((block) => block.lines.join("\n")).join("\n--\n"),
		matches: accepted.size,
		filesMatched: new Set(rows.filter((row) => accepted.has(`${row.display}:${row.line}`)).map((row) => row.display))
			.size,
	};
}

async function executeSearchFiles(
	native: AnyToolDefinition,
	args: SearchFilesInput,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<any> | undefined,
	ctx: ExtensionContext | undefined,
): Promise<AnyResult> {
	const effectiveCwd = getToolCwd(ctx, cwd);
	const requestedLimit = Math.max(1, Math.min(500, args.max_results ?? 100));
	const nativeArgs = {
		pattern: args.pattern,
		path: args.path,
		glob: args.glob,
		context: Math.max(0, Math.min(10, args.context_lines ?? 0)),
		limit: requestedLimit,
	};
	const timeoutMs = getContextValue<number>(ctx, "toolTimeoutMs") ?? SEARCH_TIMEOUT_MS;
	const execution = await executeNativeWithTimeout(
		native,
		"step-search-files",
		nativeArgs,
		signal,
		onUpdate,
		ctx,
		Math.max(1, timeoutMs),
	);
	if (execution.timedOut || !execution.result) {
		return {
			content: [{ type: "text", text: "WARNING: search_files scan timed out before all matches were collected." }],
			details: { timedOut: true, stepTruncated: true },
		} as AnyResult;
	}

	const result = execution.result;
	const rows = parseNativeSearchRows(textFromResult(result));
	const searchRoot = resolveToCwd(args.path ?? ".", effectiveCwd);
	let searchRootIsFile = false;
	try {
		searchRootIsFile = (await fsStat(searchRoot)).isFile();
	} catch {
		// Native grep already reports a path error; keep its rows as a fallback.
	}
	const files = new Map<string, string[]>();
	for (const row of rows) {
		if (files.has(row.display)) continue;
		try {
			const sourcePath = searchRootIsFile ? searchRoot : resolveNativePath(row.display, searchRoot);
			const source = await readFile(sourcePath, "utf8");
			files.set(row.display, splitTextFileLines(source));
		} catch {
			// Custom/remote grep operations may not have a local file. Keep the
			// native row as a fallback instead of losing a valid match.
		}
	}
	const rendered = renderSearchBlocks(rows, files, nativeArgs.context);
	const details = nativeDetails(result);
	const nativeCapped = typeof details.matchLimitReached === "number" || details.truncation !== undefined;
	const maxChars = resolveStepMaxChars(undefined, ctx);
	const limited = withStepTextLimit("search_files", rendered.text || "(no matches)", maxChars);
	return {
		...result,
		content: [{ type: "text", text: limited.text }],
		details: {
			...details,
			matches: rendered.matches,
			filesMatched: rendered.filesMatched,
			truncated: nativeCapped || limited.truncated,
			timedOut: false,
			stepTruncated: limited.truncated,
		},
	} as AnyResult;
}

function mapReadFileArgs(args: ReadFileInput): { path: string; offset?: number; limit?: number } {
	const start = args.start_line;
	const end = args.end_line;
	if (start !== undefined && end !== undefined && end < start) {
		throw new Error("end_line must be greater than or equal to start_line");
	}
	return {
		path: args.path,
		offset: start,
		limit:
			start !== undefined && end !== undefined
				? end - start + 1
				: start === undefined && end !== undefined
					? end
					: undefined,
	};
}

/** Apply Step's explicit character cap while retaining Pi's native image path. */
async function executeReadFile(
	native: AnyToolDefinition,
	args: ReadFileInput,
	cwd: string,
	readOptions: ReadToolOptions | undefined,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<any> | undefined,
	ctx: ExtensionContext | undefined,
): Promise<AnyResult> {
	const effectiveCwd = getToolCwd(ctx, cwd);
	const absolute = await resolveReadPathAsync(args.path, effectiveCwd);
	if (readOptions?.operations && !readOptions.operations.detectImageMimeType) {
		// A remote operation without image detection is intentionally delegated to
		// Pi's reader. Keep the original context so provider/model-aware image
		// handling and extension hooks remain intact.
		const result = await native.execute(
			"step-read-file",
			mapReadFileArgs(args),
			signal,
			onUpdate,
			ctx as ExtensionContext,
		);
		const maxChars = resolveStepMaxChars(args.max_chars, ctx);
		const limited = withReadTextLimit(textFromResult(result), maxChars);
		return limited.truncated
			? ({
					...result,
					content: [{ type: "text", text: limited.text }],
					details: { ...(nativeDetails(result) ?? {}), stepTruncated: true },
				} as AnyResult)
			: result;
	}
	const detectImage = readOptions?.operations?.detectImageMimeType ?? detectSupportedImageMimeTypeFromFile;
	let mimeType: string | null | undefined;
	try {
		mimeType = await detectImage(absolute);
	} catch {
		// Let the native reader produce its usual path-aware error (including the
		// macOS filename fallbacks) when image probing cannot access the path.
		return native.execute("step-read-file", mapReadFileArgs(args), signal, onUpdate, ctx as ExtensionContext);
	}
	if (mimeType) {
		// Line ranges do not apply to images. In particular, do not validate a
		// reversed range here: a model may include stale line arguments alongside
		// an image path and Pi's native image reader accepts that call.
		const result = await native.execute(
			"step-read-file",
			{ path: args.path },
			signal,
			onUpdate,
			ctx as ExtensionContext,
		);
		return result;
	}
	if (isCallerAborted(signal)) throw new Error("Operation aborted");
	const bytes = await (readOptions?.operations?.readFile ?? ((path: string) => readFile(path)))(absolute);
	const raw = bytes.toString("utf8");
	const lines = splitTextFileLines(raw);
	const start = (args.start_line ?? 1) - 1;
	if (start < 0) throw new Error("start_line must be greater than or equal to 1");
	if (start >= lines.length) {
		throw new Error(`Offset ${args.start_line ?? 1} is beyond end of file (${lines.length} lines total)`);
	}
	const requestedEnd = args.end_line;
	const startLine = start + 1;
	if (requestedEnd !== undefined && requestedEnd < startLine) {
		throw new Error(`end_line (${requestedEnd}) must be greater than or equal to start_line (${startLine})`);
	}
	const end = requestedEnd === undefined ? lines.length : Math.min(lines.length, requestedEnd);
	const selected = lines.slice(start, end);
	let output = selected.map((line, index) => `${startLine + index}: ${line}`).join("\n");
	const rangeWarning =
		requestedEnd !== undefined && requestedEnd > lines.length
			? `WARNING: requested end_line ${requestedEnd} exceeds the file's ${lines.length} lines; clamped to ${lines.length}.`
			: undefined;
	if (rangeWarning) {
		output = `${rangeWarning}\n${output}`;
	}
	const maxChars = resolveStepMaxChars(args.max_chars, ctx);
	const limited = withReadTextLimit(output, maxChars);
	return {
		content: [{ type: "text", text: limited.text }],
		details: {
			startLine,
			endLine: end,
			totalLines: lines.length,
			requestedEndLine: requestedEnd,
			rangeAdjusted: requestedEnd !== undefined && requestedEnd > lines.length,
			...(rangeWarning ? { warning: rangeWarning } : {}),
			stepTruncated: limited.truncated,
		},
	} as AnyResult;
}

function mapWriteFileArgs(args: WriteFileInput): WriteToolInput {
	return { path: args.path, content: args.content };
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR")
	);
}

/**
 * Execute the Step write contract while retaining Pi's native preview
 * renderer.  The native writer intentionally always writes; Step's contract
 * additionally preserves CRLF files and reports no-op writes, so the adapter
 * performs the small read/compare before delegating the actual filesystem
 * operations.
 */
async function executeStepWriteFile(
	args: WriteFileInput,
	cwd: string,
	writeOptions: WriteToolOptions | undefined,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext | undefined,
): Promise<AnyResult> {
	const absolutePath = resolveToCwd(args.path, getToolCwd(ctx, cwd));
	const configured = writeOptions?.operations;
	const readExisting = configured?.readFile ?? ((filePath: string) => readFile(filePath));
	const write = configured?.writeFile ?? ((filePath: string, content: string) => writeFile(filePath, content, "utf8"));
	const mkdir =
		configured?.mkdir ?? ((directory: string) => fsMkdir(directory, { recursive: true }).then(() => undefined));
	const throwIfAborted = (): void => {
		if (signal?.aborted) throw new Error("Operation aborted");
	};

	return withFileMutationQueue(absolutePath, async () => {
		throwIfAborted();
		let existing: string | undefined;
		try {
			const value = await readExisting(absolutePath);
			existing = Buffer.isBuffer(value) ? value.toString("utf8") : value;
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
		}
		throwIfAborted();

		const content = existing === undefined ? args.content : alignTextToFileEol(existing, args.content);
		const changed = existing !== content;
		if (!changed) {
			return {
				content: [{ type: "text", text: `${args.path} already matches the requested content.` }],
				details: {
					path: args.path,
					bytesWritten: 0,
					charsWritten: 0,
					requestedBytes: Buffer.byteLength(content, "utf8"),
					requestedChars: content.length,
					changed: false,
				},
			} as AnyResult;
		}

		await mkdir(path.dirname(absolutePath));
		throwIfAborted();
		await write(absolutePath, content);
		throwIfAborted();
		return {
			content: [{ type: "text", text: `Wrote ${content.length} chars to ${args.path}.` }],
			details: {
				path: args.path,
				bytesWritten: Buffer.byteLength(content, "utf8"),
				charsWritten: content.length,
				changed: true,
			},
		} as AnyResult;
	});
}

function mapEditFileArgs(args: EditFileInput): { path: string; edits: Array<{ oldText: string; newText: string }> } {
	return { path: args.path, edits: [{ oldText: args.search, newText: args.replace }] };
}

function mapRunCommandArgs(args: RunCommandInput, ctx?: ExtensionContext): { command: string; timeout?: number } {
	if (
		args.timeout_ms !== undefined &&
		(args.timeout_ms < MIN_COMMAND_TIMEOUT_MS ||
			args.timeout_ms > MAX_COMMAND_TIMEOUT_MS ||
			!Number.isInteger(args.timeout_ms))
	) {
		throw new Error(`timeout_ms must be between ${MIN_COMMAND_TIMEOUT_MS} and ${MAX_COMMAND_TIMEOUT_MS}`);
	}
	if (
		args.max_output_chars !== undefined &&
		(args.max_output_chars < MIN_COMMAND_OUTPUT_CHARS ||
			args.max_output_chars > MAX_COMMAND_OUTPUT_CHARS ||
			!Number.isInteger(args.max_output_chars))
	) {
		throw new Error(`max_output_chars must be between ${MIN_COMMAND_OUTPUT_CHARS} and ${MAX_COMMAND_OUTPUT_CHARS}`);
	}
	const configuredTimeout = getContextValue<number>(ctx, "commandTimeoutMs");
	const timeoutMs = args.timeout_ms ?? (typeof configuredTimeout === "number" ? configuredTimeout : undefined);
	return {
		command: args.command,
		timeout: timeoutMs === undefined ? undefined : timeoutMs / 1000,
	};
}

/** Execute Step's literal edit contract while retaining Pi's renderer/preview. */
async function executeStepEdit(
	native: ToolDefinition<any, EditToolDetails | undefined>,
	toolCallId: string,
	args: EditFileInput,
	cwd: string,
	editOptions: EditToolOptions | undefined,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<any> | undefined,
	ctx: ExtensionContext | undefined,
): Promise<AnyResult> {
	void native;
	void toolCallId;
	void onUpdate;
	if (args.search.length === 0) throw new Error("search must not be empty");
	const absolutePath = resolveToCwd(args.path, getToolCwd(ctx, cwd));
	const operations: EditOperations = editOptions?.operations ?? {
		readFile: (filePath) => readFile(filePath),
		writeFile: (filePath, content) => writeFile(filePath, content, "utf8"),
		access: async (filePath) => {
			await fsStat(filePath);
		},
	};
	return withFileMutationQueue(absolutePath, async () => {
		if (isCallerAborted(signal)) throw new Error("Operation aborted");
		await operations.access(absolutePath);
		const original = (await operations.readFile(absolutePath)).toString("utf8");
		if (isCallerAborted(signal)) throw new Error("Operation aborted");

		// Align only the caller's search/replacement text. This lets a model copy
		// LF lines from read_file into an all-CRLF file without rewriting unrelated
		// line endings, while mixed-ending files remain byte-for-byte untouched.
		const search = alignTextToFileEol(original, args.search);
		const replacement = alignTextToFileEol(original, args.replace);
		const occurrences = countOccurrences(original, search);
		if (occurrences === 0) throw new Error(`No matches for search string in ${args.path}`);
		if (!args.replace_all && occurrences > 1) {
			throw new Error(
				`Search string occurs ${occurrences} times in ${args.path}; provide a unique search string or set replace_all=true`,
			);
		}
		// split/join replaces literally: unlike String.prototype.replace it never interprets
		// `$&`, `$\``, `$'`, `$n`, or `$$` in the replacement. Without replace_all, occurrences
		// is exactly 1 (guarded above), so this replaces just that one match.
		const updated = original.split(search).join(replacement);
		const replacedCount = args.replace_all ? occurrences : 1;
		if (updated === original) {
			return {
				content: [{ type: "text", text: `No textual changes needed in ${args.path}.` }],
				details: { changed: false, replacedCount: 0, matchCount: occurrences },
			} as AnyResult;
		}

		await operations.writeFile(absolutePath, updated);
		if (isCallerAborted(signal)) throw new Error("Operation aborted");
		const normalizedOriginal = normalizeToLF(original);
		const normalizedUpdated = normalizeToLF(updated);
		const diff = generateDiffString(normalizedOriginal, normalizedUpdated);
		return {
			content: [{ type: "text", text: `Successfully replaced ${replacedCount} occurrence(s) in ${args.path}.` }],
			details: {
				diff: diff.diff,
				patch: generateUnifiedPatch(args.path, normalizedOriginal, normalizedUpdated),
				firstChangedLine: diff.firstChangedLine,
				changed: true,
				replacedCount,
				matchCount: occurrences,
			},
		} as AnyResult;
	});
}

function usesCrlfOnly(content: string): boolean {
	const crlfCount = countOccurrences(content, "\r\n");
	return crlfCount > 0 && countOccurrences(content, "\n") === crlfCount;
}

function alignTextToFileEol(fileContent: string, text: string): string {
	if (!text.includes("\n") || text.includes("\r\n") || !usesCrlfOnly(fileContent)) return text;
	return text.replaceAll("\n", "\r\n");
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let offset = 0;
	while (true) {
		const index = text.indexOf(needle, offset);
		if (index < 0) return count;
		count += 1;
		offset = index + needle.length;
	}
}

function createFindToolsDefinition(
	definitions: readonly AnyToolDefinition[],
): ToolDefinition<typeof findToolsSchema, undefined> {
	return {
		name: "find_tools",
		label: "find_tools",
		description: "Search registered tools by natural-language intent, tool name, description, and parameter names.",
		promptSnippet: "Find a tool by describing the operation you need",
		parameters: findToolsSchema,
		execute: async (_toolCallId, args: FindToolsInput) => {
			const queryTokens = args.query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
			const limit = Math.max(1, Math.min(20, args.limit ?? 8));
			const matches = definitions
				.map((definition) => {
					const haystack =
						`${definition.name} ${definition.description} ${JSON.stringify(definition.parameters)}`.toLowerCase();
					const score = queryTokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
					return { definition, score };
				})
				.filter((entry) => entry.score > 0)
				.sort(
					(left, right) => right.score - left.score || left.definition.name.localeCompare(right.definition.name),
				)
				.slice(0, limit);
			const content = matches.length
				? matches
						.map(
							({ definition, score }, index) =>
								`${index + 1}. ${definition.name} [score=${score}]\ndescription: ${definition.description}`,
						)
						.join("\n\n")
				: "(no matching tools)";
			return {
				content: [{ type: "text", text: content }],
				details: undefined,
			};
		},
	};
}

/**
 * Detached run for long-lived processes (dev servers, watchers). The child
 * outlives the tool call but not the session: its pid stays in the detached
 * registry until it exits, and session shutdown kills whatever is left.
 */
async function startBackgroundCommand(
	command: string,
	commandCwd: string,
	options: { shellPath?: string; agentDir?: string },
): Promise<AnyResult> {
	try {
		await fsStat(commandCwd);
	} catch {
		throw new Error(`Working directory does not exist: ${commandCwd}`);
	}
	const shellConfig = getShellConfig(options.shellPath);
	const logPath = path.join(os.tmpdir(), `step-run-bg-${process.pid}-${randomUUID().slice(0, 8)}.log`);
	const logFd = openSync(logPath, "a", 0o600);
	let child: ChildProcess;
	try {
		child = spawnShellChild(shellConfig, command, {
			cwd: commandCwd,
			env: getShellEnv(options.agentDir),
			stdout: logFd,
			stderr: logFd,
		});
	} finally {
		// The child holds its own duplicated descriptors after spawn.
		closeSync(logFd);
	}
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", () => resolve());
		child.once("error", (error) => reject(error));
	});
	const pid = child.pid;
	if (pid !== undefined) {
		trackDetachedChildPid(pid);
		child.once("exit", () => untrackDetachedChildPid(pid));
	}
	child.unref();
	// Stop the whole process tree, not just the wrapper shell. The child is spawned
	// detached (a process-group leader on Unix), so a bare `kill <pid>` signals only the
	// wrapper and orphans the real process (e.g. the dev server it launched). Unix:
	// `kill -TERM -<pid>` signals the group — a leading `-<pid>` without a signal token
	// parses as a signal number, so -TERM is required. Windows run_command routes through
	// Git Bash, so MSYS_NO_PATHCONV=1 keeps it from mangling taskkill's /F /T /PID flags
	// (without it MSYS rewrites `/F` to `F:/` and taskkill rejects the argument). Verified
	// on real Git Bash (MINGW64): the returned command terminates the whole tree (exit 0).
	const stopCommand =
		pid === undefined
			? undefined
			: process.platform === "win32"
				? `MSYS_NO_PATHCONV=1 taskkill /F /T /PID ${pid}`
				: `kill -TERM -${pid}`;
	return {
		content: [
			{
				type: "text",
				text: [
					`Started background command (pid ${pid ?? "unknown"}).`,
					`Log: ${logPath}`,
					stopCommand === undefined
						? "Check progress with read_file on the log."
						: `Check progress with read_file on the log; stop it and its child processes with run_command(${JSON.stringify(stopCommand)}).`,
				].join("\n"),
			},
		],
		details: { background: true, pid: pid ?? null, logPath },
	};
}

/** Create Step-facing definitions backed by Pi's native tools. */
export function createStepToolProfile(cwd: string, options: StepToolProfileOptions = {}): AnyToolDefinition[] {
	// A Step profile is also used by embedded hosts that do not launch
	// Embedded hosts may bypass the Step entrypoint (and therefore never run
	// step-bootstrap.ts). Resolve the
	// product root here so native fd/rg/bash definitions cannot fall back to
	// Pi's process-global ~/.pi/agent directory.
	const agentDir = resolvePath(options.agentDir?.trim() || resolveStepAgentDir());
	const withAgentDir = <T extends { agentDir?: string }>(toolOptions: T | undefined): T => {
		if (toolOptions?.agentDir) return toolOptions;
		return { ...(toolOptions ?? {}), agentDir } as T;
	};
	const nativeFindOptions = withAgentDir(options.find);
	const nativeGrepOptions = withAgentDir(options.grep);
	const nativeBashOptions = withAgentDir(options.bash);
	const nativeLs = createLsToolDefinition(cwd, options.ls);
	const nativeFind = createFindToolDefinition(cwd, nativeFindOptions);
	const nativeGrep = createGrepToolDefinition(cwd, nativeGrepOptions);
	const nativeRead = createReadToolDefinition(cwd, options.read);
	const nativeWrite = createWriteToolDefinition(cwd, options.write);
	const nativeEdit = createEditToolDefinition(cwd, options.edit);
	const nativeBash = createBashToolDefinition(cwd, nativeBashOptions);
	const searchWeb = createSearchWebTool(options.searchWeb);

	const listDirectoryBase = aliasDefinition(
		{
			name: "list_directory",
			label: "list_directory",
			description: "List one directory with directories first. Prefer this before recursive shell listing.",
			promptSnippet: "List one directory with directories first",
			parameters: listDirectorySchema,
		},
		nativeLs,
		mapListDirectoryArgs,
	);
	const listDirectory = {
		...listDirectoryBase,
		execute: (
			_toolCallId: string,
			args: ListDirectoryInput,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<any> | undefined,
			ctx: ExtensionContext,
		) => executeListDirectory(args, getToolCwd(ctx, cwd), options.ls?.operations, signal),
	} as AnyToolDefinition;

	const findFilesBase = aliasDefinition(
		{
			name: "find_files",
			label: "find_files",
			description:
				"Find files by glob pattern, sorted by modification time (newest first). Prefer this over shell find or recursive ls.",
			promptSnippet: "Find files by glob pattern",
			parameters: findFilesSchema,
		},
		nativeFind,
		mapFindFilesArgs,
	);
	const findFiles = {
		...findFilesBase,
		execute: (
			_toolCallId: string,
			args: FindFilesInput,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<any> | undefined,
			ctx: ExtensionContext,
		) => executeFindFiles(nativeFind, args, cwd, signal, onUpdate, ctx),
	} as AnyToolDefinition;

	const searchFilesBase = aliasDefinition(
		{
			name: "search_files",
			label: "search_files",
			description:
				"Search file contents with a regular expression. Returns matching file paths, line numbers, and matched lines. Prefer this over shell grep.",
			promptSnippet: "Search file contents with a regular expression",
			parameters: searchFilesSchema,
		},
		nativeGrep,
		mapSearchFilesArgs,
	);
	const searchFiles = {
		...searchFilesBase,
		execute: (
			_toolCallId: string,
			args: SearchFilesInput,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<any> | undefined,
			ctx: ExtensionContext,
		) => executeSearchFiles(nativeGrep, args, cwd, signal, onUpdate, ctx),
	} as AnyToolDefinition;

	const readFileBase = aliasDefinition(
		{
			name: "read_file",
			label: "read_file",
			description: READ_FILE_DESCRIPTION,
			promptSnippet: "Read a file with an optional line range",
			parameters: readFileSchema,
		},
		nativeRead,
		mapReadFileArgs,
	);
	const readFile = {
		...readFileBase,
		execute: (
			_toolCallId: string,
			args: ReadFileInput,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<any> | undefined,
			ctx: ExtensionContext,
		) => executeReadFile(nativeRead, args, cwd, options.read, signal, onUpdate, ctx),
	} as AnyToolDefinition;

	const writeFileBase = aliasDefinition(
		{
			name: "write_file",
			label: "write_file",
			description: WRITE_FILE_DESCRIPTION,
			promptSnippet: "Write full content to a file",
			parameters: writeFileSchema,
		},
		nativeWrite,
		mapWriteFileArgs,
	);
	const writeFile = {
		...writeFileBase,
		execute: (
			_toolCallId: string,
			args: WriteFileInput,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<any> | undefined,
			ctx: ExtensionContext,
		) => executeStepWriteFile(args, cwd, options.write, signal, ctx),
	} as AnyToolDefinition;

	const editFile: ToolDefinition<typeof editFileSchema, EditToolDetails | undefined> = {
		name: "edit_file",
		label: "edit_file",
		description:
			"Edit one file by literal search/replace. 'search' must match the current file content exactly and appear exactly once unless replace_all is true.",
		promptSnippet: "Make a precise literal search/replace edit",
		promptGuidelines: [
			"Use edit_file for precise changes; set replace_all=true only when every occurrence should change.",
		],
		parameters: editFileSchema,
		constrainedSampling: nativeEdit.constrainedSampling,
		executionMode: nativeEdit.executionMode,
		renderShell: nativeEdit.renderShell,
		execute: (toolCallId, args, signal, onUpdate, ctx) =>
			executeStepEdit(nativeEdit, toolCallId, args, cwd, options.edit, signal, onUpdate, ctx),
		renderCall: nativeEdit.renderCall
			? (args, theme, context) =>
					nativeEdit.renderCall!(mapEditFileArgs(args), theme, {
						...context,
						args: mapEditFileArgs(args),
					})
			: undefined,
		renderResult: nativeEdit.renderResult
			? (result, renderOptions, theme, context) =>
					nativeEdit.renderResult!(result, renderOptions, theme, {
						...context,
						args: mapEditFileArgs(context.args),
					})
			: undefined,
	};

	const runCommand: ToolDefinition<typeof runCommandSchema> = {
		name: "run_command",
		label: "run_command",
		description:
			"Run a non-interactive shell command from the initial working directory by default. Use for tests, builds, formatters, git, and project scripts; prefer dedicated file/search tools for reading and searching.",
		promptSnippet: "Run a non-interactive shell command",
		parameters: runCommandSchema,
		constrainedSampling: nativeBash.constrainedSampling,
		executionMode: nativeBash.executionMode,
		execute: async (toolCallId, args, signal, onUpdate, ctx) => {
			const effectiveCwd = getToolCwd(ctx, cwd);
			const commandCwd = resolveToCwd(args.cwd ?? ".", effectiveCwd);
			if (args.run_in_background === true) {
				return startBackgroundCommand(args.command, commandCwd, {
					...(nativeBashOptions.shellPath ? { shellPath: nativeBashOptions.shellPath } : {}),
					agentDir,
				});
			}
			const nativeForCwd =
				args.cwd === undefined ? nativeBash : createBashToolDefinition(commandCwd, nativeBashOptions);
			const result = await nativeForCwd.execute(toolCallId, mapRunCommandArgs(args, ctx), signal, onUpdate, ctx);
			return applyStepTextLimit(result, "run_command", resolveStepMaxChars(args.max_output_chars, ctx));
		},
		renderCall: nativeBash.renderCall
			? (args, theme, context) =>
					nativeBash.renderCall!(mapRunCommandArgs(args), theme, {
						...context,
						args: mapRunCommandArgs(args),
					})
			: undefined,
		renderResult: nativeBash.renderResult
			? (result, renderOptions, theme, context) =>
					nativeBash.renderResult!(result as any, renderOptions, theme, {
						...context,
						args: mapRunCommandArgs(context.args),
					})
			: undefined,
	};

	const profileWithoutFindTools: AnyToolDefinition[] = [
		listDirectory,
		findFiles,
		searchFiles,
		searchWeb,
		readFile,
		writeFile,
		editFile,
		runCommand,
	];
	const findTools = createFindToolsDefinition(profileWithoutFindTools);
	return [...profileWithoutFindTools, findTools];
}

/** True for the Step model-facing names. */
export function isStepToolName(name: string): name is StepToolName {
	return (STEP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Native Pi names are intentionally inactive in the Step profile. */
export function isPiNativeToolName(name: string): boolean {
	return STEP_NATIVE_TOOL_NAMES.has(name);
}
