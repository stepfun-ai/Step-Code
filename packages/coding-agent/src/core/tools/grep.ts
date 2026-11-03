import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@step-harness/agent-core";
import { Text } from "@step-harness/pi-tui";
import { spawn, spawnSync } from "child_process";
import { minimatch } from "minimatch";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../render/keybinding-hints.ts";
import type { Theme } from "../../theme/theme.ts";
import { commandExists, ensureTool } from "../../utils/tools-manager.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export const grepToolSystemPromptContribution = {
	snippet: "Search file contents for patterns (respects .gitignore)",
	guidelines: [],
} as const;

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
	backend?: SearchBackendName;
	/**
	 * Structured match rows, for consumers that need the exact file/line rather
	 * than the rendered text. The backends already know these values; without
	 * this they were flattened into `path:line: text` and had to be parsed back
	 * out, which silently mis-reads any row whose path or text itself contains a
	 * `:<digits>:` shape. Never sent to the LLM (details are local metadata).
	 */
	matchRows?: GrepMatchRow[];
}

/** One matched row in the shape consumers can act on without re-parsing text. */
export interface GrepMatchRow {
	/** Path relative to the search root, using forward slashes. */
	path: string;
	line: number;
	text: string;
}

/** Match tuple produced by every search backend; the caller formats it. */
export interface GrepMatch {
	filePath: string;
	lineNumber: number;
	/** Match line text if the backend already read it; otherwise loaded via ops.readFile. */
	lineText?: string;
}

/** Parameters shared by every backend implementation. */
export interface GrepSearchParams {
	pattern: string;
	searchPath: string;
	ignoreCase: boolean;
	literal: boolean;
	glob?: string;
	limit: number;
	signal?: AbortSignal;
}

export interface GrepSearchResult {
	matches: GrepMatch[];
	matchLimitReached: boolean;
}

export type SearchBackendName = "ripgrep" | "git-grep" | "grep" | "custom";

/**
 * Pluggable operations for the grep tool.
 *
 * `search` mirrors `FindOperations.glob`: when a caller provides it, the tool
 * skips the built-in rg / git grep / POSIX grep ladder and delegates the entire
 * search to that operation. Remote/VM backends can substitute both file listing
 * and text search this way.
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
	/** Custom search primitive. Wins over every built-in backend. */
	search?: (params: GrepSearchParams) => Promise<GrepSearchResult> | GrepSearchResult;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep with git/POSIX fallbacks. */
	operations?: GrepOperations;
	/** Agent directory used for managed ripgrep storage. Defaults to Pi's agent directory. */
	agentDir?: string;
}

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: Theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

/**
 * Pick the first available search backend.
 *
 * Ladder: injected custom → downloaded/PATH ripgrep → git grep (when the search
 * path is inside a git worktree and `git` is on PATH) → POSIX `grep`. Only the
 * final "nothing available" case throws.
 *
 * `.gitignore` respect: ripgrep and git grep honor it; POSIX grep does not.
 * Falling through to POSIX grep is deliberate — hard-failing (previous behavior)
 * left the caller with no search at all, which stalled agents inside evaluation
 * sandboxes where rg cannot be downloaded.
 */
async function selectSearchBackend(
	searchPath: string,
	options: { agentDir?: string; custom?: GrepOperations["search"] },
): Promise<SearchBackend> {
	if (options.custom) {
		const custom = options.custom;
		return {
			name: "custom",
			run: async (params) => await custom(params),
		};
	}
	const rgPath = await ensureTool("rg", undefined, { agentDir: options.agentDir });
	if (rgPath) return createRipgrepBackend(rgPath);
	if (commandExists("git") && isInsideGitWorkTree(searchPath)) return createGitGrepBackend();
	if (commandExists("grep")) return createPosixGrepBackend();
	throw new Error(
		"No search backend available: ripgrep could not be resolved and neither `git` nor `grep` is on PATH.",
	);
}

interface SearchBackend {
	readonly name: SearchBackendName;
	run(params: GrepSearchParams): Promise<GrepSearchResult>;
}

function isInsideGitWorkTree(cwd: string): boolean {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	return result.status === 0 && result.stdout.toString().trim() === "true";
}

function createRipgrepBackend(rgPath: string): SearchBackend {
	return {
		name: "ripgrep",
		run(params) {
			return new Promise((resolve, reject) => {
				if (params.signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
				if (params.ignoreCase) args.push("--ignore-case");
				if (params.literal) args.push("--fixed-strings");
				if (params.glob) args.push("--glob", params.glob);
				args.push("--", params.pattern, params.searchPath);

				const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
				const rl = createInterface({ input: child.stdout });
				let stderr = "";
				const matches: GrepMatch[] = [];
				let matchLimitReached = false;
				let aborted = false;
				let killedDueToLimit = false;
				let settled = false;

				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					rl.close();
					params.signal?.removeEventListener("abort", onAbort);
					fn();
				};
				const stopChild = (dueToLimit = false) => {
					if (!child.killed) {
						killedDueToLimit = dueToLimit;
						child.kill();
					}
				};
				const onAbort = () => {
					aborted = true;
					stopChild();
				};
				params.signal?.addEventListener("abort", onAbort, { once: true });

				child.stderr?.on("data", (chunk) => {
					stderr += chunk.toString();
				});

				rl.on("line", (line) => {
					if (!line.trim() || matches.length >= params.limit) return;
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}
					if (event.type !== "match") return;
					const filePath = event.data?.path?.text;
					const lineNumber = event.data?.line_number;
					const lineText = event.data?.lines?.text;
					if (typeof filePath !== "string" || typeof lineNumber !== "number") return;
					matches.push({ filePath, lineNumber, lineText });
					if (matches.length >= params.limit) {
						matchLimitReached = true;
						stopChild(true);
					}
				});

				child.on("error", (error) => {
					settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
				});
				child.on("close", (code) => {
					if (aborted) {
						settle(() => reject(new Error("Operation aborted")));
						return;
					}
					if (!killedDueToLimit && code !== 0 && code !== 1) {
						const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
						settle(() => reject(new Error(errorMsg)));
						return;
					}
					settle(() => resolve({ matches, matchLimitReached }));
				});
			});
		},
	};
}

/**
 * Parse one record emitted by git grep / POSIX grep.
 *
 * Both backends can separate the path from the rest with a NUL byte, which is
 * the only form that stays unambiguous when a path or a matched line itself
 * contains a `:<digits>:` shape. We ask for NUL output from both:
 *
 * - `git grep -z` emits `path\0line\0text` and escapes special bytes in the
 *   path into the Unicode private use area (`0xF000 + byte`), so `a:b.ts`
 *   arrives as `a\uF03Ab.ts`; that is decoded back here.
 * - `grep -Z` emits `path\0line:text` with the path verbatim.
 *
 * The legacy colon form is still accepted for custom backends that emit it.
 * The NUL forms are tried first: they carry the field boundary, so no guessing
 * is involved.
 */
function parseGrepLine(line: string): GrepMatch | null {
	const nulParts = line.split("\0");
	if (nulParts.length >= 3) {
		// git grep -z: path\0line\0text
		const [rawPath, lineNumStr, ...rest] = nulParts;
		const match = finishGrepMatch(decodeGitPath(rawPath ?? ""), lineNumStr ?? "", rest.join("\0"));
		if (match) return match;
	}
	if (nulParts.length === 2) {
		// grep -Z: path\0line:text
		const [rawPath, tail] = nulParts;
		const separator = (tail ?? "").indexOf(":");
		if (separator > 0) {
			return finishGrepMatch(rawPath ?? "", (tail ?? "").slice(0, separator), (tail ?? "").slice(separator + 1));
		}
	}
	// Legacy colon form: `path:line:text`, first ":<digits>:" delimiter wins.
	const match = line.match(/^([^\0]+?):(\d+):(.*)$/);
	if (!match) return null;
	const [, filePath, lineNumStr, lineText] = match;
	return finishGrepMatch(filePath ?? "", lineNumStr ?? "", lineText ?? "");
}

function finishGrepMatch(filePath: string, lineNumStr: string, lineText: string): GrepMatch | null {
	if (!filePath) return null;
	const lineNumber = Number.parseInt(lineNumStr, 10);
	if (!Number.isInteger(lineNumber) || lineNumber < 1) return null;
	return { filePath, lineNumber, lineText };
}

/**
 * Undo the path escaping `git grep -z` applies: bytes that would be ambiguous in
 * its output are shifted into the private use area as `0xF000 + byte`.
 */
function decodeGitPath(raw: string): string {
	if (!/[\uF000-\uF0FF]/u.test(raw)) return raw;
	return raw.replace(/[\uF000-\uF0FF]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xf000));
}

/** Common driver for a `<cmd> ... -n` fallback backend that streams `path:line:content`. */
function runLinePrefixedSearch(
	backendName: SearchBackendName,
	command: string,
	args: string[],
	options: {
		cwd?: string;
		resolvePath: (raw: string) => string;
		params: GrepSearchParams;
		globFilter?: (relative: string) => boolean;
	},
): Promise<GrepSearchResult> {
	return new Promise((resolve, reject) => {
		if (options.params.signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const rl = createInterface({ input: child.stdout });
		let stderr = "";
		const matches: GrepMatch[] = [];
		let matchLimitReached = false;
		let aborted = false;
		let killedDueToLimit = false;
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			rl.close();
			options.params.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const stopChild = (dueToLimit = false) => {
			if (!child.killed) {
				killedDueToLimit = dueToLimit;
				child.kill();
			}
		};
		const onAbort = () => {
			aborted = true;
			stopChild();
		};
		options.params.signal?.addEventListener("abort", onAbort, { once: true });

		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		rl.on("line", (line) => {
			if (!line || matches.length >= options.params.limit) return;
			const parsed = parseGrepLine(line);
			if (!parsed) return;
			if (options.globFilter && !options.globFilter(parsed.filePath)) return;
			matches.push({
				filePath: options.resolvePath(parsed.filePath),
				lineNumber: parsed.lineNumber,
				lineText: parsed.lineText,
			});
			if (matches.length >= options.params.limit) {
				matchLimitReached = true;
				stopChild(true);
			}
		});

		child.on("error", (error) => {
			settle(() => reject(new Error(`Failed to run ${backendName}: ${error.message}`)));
		});
		child.on("close", (code) => {
			if (aborted) {
				settle(() => reject(new Error("Operation aborted")));
				return;
			}
			// grep / git grep exit 1 when there are no matches; that is success for us.
			if (!killedDueToLimit && code !== 0 && code !== 1) {
				const errorMsg = stderr.trim() || `${backendName} exited with code ${code}`;
				settle(() => reject(new Error(errorMsg)));
				return;
			}
			settle(() => resolve({ matches, matchLimitReached }));
		});
	});
}

function createGitGrepBackend(): SearchBackend {
	return {
		name: "git-grep",
		async run(params) {
			// Search a directory from its own cwd so pathspecs stay relative; when
			// the caller asked about a single file, pin to its parent and search
			// only that basename.
			let cwd = params.searchPath;
			let pathspec = ".";
			try {
				const stat = await fsStat(params.searchPath);
				if (stat.isFile()) {
					cwd = path.dirname(params.searchPath);
					pathspec = path.basename(params.searchPath);
				}
			} catch {
				// Path validation runs before backend dispatch; unexpected here.
				return { matches: [], matchLimitReached: false };
			}

			const args: string[] = ["grep", "-n", "-I", "--no-color", "--untracked", "-z"];
			if (params.ignoreCase) args.push("-i");
			if (params.literal) args.push("-F");
			else args.push("-E");
			args.push("-e", params.pattern, "--");
			if (params.glob) {
				// Pathspec magic `:(glob)` gives ripgrep-style ** semantics; also
				// scope to the pathspec base when searching a subdir.
				args.push(`:(glob)${params.glob}`);
			} else {
				args.push(pathspec);
			}

			return runLinePrefixedSearch("git-grep", "git", args, {
				cwd,
				resolvePath: (raw) => path.resolve(cwd, raw),
				params,
			});
		},
	};
}

/** minimatch adapter with `dot: true` — hidden files should participate in globs. */
function globMatch(input: string, pattern: string): boolean {
	return minimatch(input, pattern, { dot: true });
}

/**
 * GNU grep understands `-Z` (filename followed by NUL); BSD grep does not.
 * The distinction matters only for ambiguity in the path, so we gate on the
 * implementations that are actually GNU-compatible rather than probing.
 */
function posixGrepSupportsNulPath(): boolean {
	return process.platform !== "darwin" && process.platform !== "freebsd";
}

function createPosixGrepBackend(): SearchBackend {
	return {
		name: "grep",
		async run(params) {
			const args = ["-r", "-n", "-H", "-I"];
			// GNU grep: -Z writes the filename verbatim, NUL-terminated, so a path
			// containing ":<digits>:" can never be mistaken for the line separator.
			// BSD grep (macOS) lacks -Z; there the legacy "path:line:text" form is
			// parsed instead (see parseGrepLine), so the flag is best-effort.
			const supportsNulPath = posixGrepSupportsNulPath();
			if (supportsNulPath) args.push("-Z");
			if (params.ignoreCase) args.push("-i");
			if (params.literal) args.push("-F");
			else args.push("-E");
			args.push("-e", params.pattern, "--", params.searchPath);

			// Complex globs (containing `/` or `**`) require post-filtering because
			// GNU grep --include=<glob> uses fnmatch and won't cross directories.
			let globFilter: ((relative: string) => boolean) | undefined;
			if (params.glob) {
				const pattern = params.glob;
				const rootStat = await fsStat(params.searchPath).catch(() => null);
				const rootIsDir = rootStat?.isDirectory() ?? false;
				globFilter = (absolute) => {
					const relative = rootIsDir ? path.relative(params.searchPath, absolute) : path.basename(absolute);
					// Try both full relative and basename so short patterns like `*.ts` work.
					return globMatch(relative, pattern) || globMatch(path.basename(absolute), pattern);
				};
			}

			return runLinePrefixedSearch("grep", "grep", args, {
				resolvePath: (raw) => path.resolve(raw),
				params,
				globFilter,
			});
		},
	};
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore when ripgrep or git grep is available. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
		) {
			if (signal?.aborted) throw new Error("Operation aborted");

			const searchPath = resolveToCwd(searchDir || ".", cwd);
			const ops = customOps ?? defaultGrepOperations;
			let isDirectory: boolean;
			try {
				isDirectory = await ops.isDirectory(searchPath);
			} catch {
				throw new Error(`Path not found: ${searchPath}`);
			}

			const backend = await selectSearchBackend(searchPath, {
				agentDir: options?.agentDir,
				custom: customOps?.search,
			});
			if (signal?.aborted) throw new Error("Operation aborted");

			const contextValue = context && context > 0 ? context : 0;
			const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

			const { matches, matchLimitReached } = await backend.run({
				pattern,
				searchPath,
				ignoreCase: !!ignoreCase,
				literal: !!literal,
				glob,
				limit: effectiveLimit,
				signal,
			});

			const formatPath = (filePath: string): string => {
				if (isDirectory) {
					const relative = path.relative(searchPath, filePath);
					if (relative && !relative.startsWith("..")) {
						return relative.replace(/\\/g, "/");
					}
				}
				return path.basename(filePath);
			};

			const fileCache = new Map<string, string[]>();
			const getFileLines = async (filePath: string): Promise<string[]> => {
				let lines = fileCache.get(filePath);
				if (!lines) {
					try {
						const content = await ops.readFile(filePath);
						lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
					} catch {
						lines = [];
					}
					fileCache.set(filePath, lines);
				}
				return lines;
			};

			const outputLines: string[] = [];
			let linesTruncated = false;

			const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
				const relativePath = formatPath(filePath);
				const lines = await getFileLines(filePath);
				if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
				const block: string[] = [];
				const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
				const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
				for (let current = start; current <= end; current++) {
					const lineText = lines[current - 1] ?? "";
					const sanitized = lineText.replace(/\r/g, "");
					const isMatchLine = current === lineNumber;
					const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
					if (wasTruncated) linesTruncated = true;
					if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
					else block.push(`${relativePath}-${current}- ${truncatedText}`);
				}
				return block;
			};

			if (matches.length === 0) {
				return { content: [{ type: "text", text: "No matches found" }], details: undefined };
			}

			// Rows in the exact shape the render path uses, so a consumer reading
			// these gets the same numbers the rendered text shows — without having
			// to parse that text back out.
			const matchRows: GrepMatchRow[] = [];

			for (const match of matches) {
				const relativePath = formatPath(match.filePath);
				if (contextValue === 0 && match.lineText !== undefined) {
					const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
					const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
					if (wasTruncated) linesTruncated = true;
					outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
					matchRows.push({ path: relativePath, line: match.lineNumber, text: truncatedText });
				} else {
					const block = await formatBlock(match.filePath, match.lineNumber);
					outputLines.push(...block);
					matchRows.push({
						path: relativePath,
						line: match.lineNumber,
						text: match.lineText !== undefined ? match.lineText.replace(/\r/g, "").replace(/\n$/, "") : "",
					});
				}
			}

			const rawOutput = outputLines.join("\n");
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: GrepToolDetails = { backend: backend.name, matchRows };
			const notices: string[] = [];
			if (matchLimitReached) {
				notices.push(
					`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
				);
				details.matchLimitReached = effectiveLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (linesTruncated) {
				notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				details.linesTruncated = true;
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			return {
				content: [{ type: "text", text: output }],
				details,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
