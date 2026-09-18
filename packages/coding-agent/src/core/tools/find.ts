import { stat as fsStat } from "node:fs/promises";
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
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

/** Relativize a find result against the search root and normalize it to posix separators. */
export function relativizeFindResultPath(
	resultPath: string,
	searchPath: string,
	pathModule: path.PlatformPath = path,
): string {
	const hadTrailingSeparator =
		resultPath.endsWith(pathModule.sep) || (pathModule.sep === "\\" && resultPath.endsWith("/"));
	const relativePath = pathModule.isAbsolute(resultPath) ? pathModule.relative(searchPath, resultPath) : resultPath;
	const posixPath = relativePath.split(pathModule.sep).join("/");
	return hadTrailingSeparator && !posixPath.endsWith("/") ? `${posixPath}/` : posixPath;
}

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export const findToolSystemPromptContribution = {
	snippet: "Find files by glob pattern (respects .gitignore)",
	guidelines: [],
} as const;

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export type FindBackendName = "fd" | "git-ls" | "find" | "custom";

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	backend?: FindBackendName;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: pathExists,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus fd with git/POSIX fallbacks. */
	operations?: FindOperations;
	/** Agent directory used for managed fd storage. Defaults to Pi's agent directory. */
	agentDir?: string;
}

function formatFindCall(args: { pattern: string; path?: string; limit?: number } | undefined, theme: Theme): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("find")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

interface FileListBackend {
	readonly name: FindBackendName;
	run(params: { pattern: string; searchPath: string; limit: number; signal?: AbortSignal }): Promise<string[]>;
}

/**
 * Pick the first available file-listing backend.
 *
 * Ladder: downloaded/PATH fd → git ls-files (when the search path is inside a
 * git worktree and `git` is on PATH) → POSIX `find`. `.gitignore` respect is
 * lost at the POSIX rung; hard-failing (previous behavior) left the caller
 * with no listing at all inside sandboxes without fd or GitHub egress.
 */
async function selectFileListBackend(searchPath: string, options: { agentDir?: string }): Promise<FileListBackend> {
	const fdPath = await ensureTool("fd", undefined, { agentDir: options.agentDir });
	if (fdPath) return createFdBackend(fdPath);
	if (commandExists("git") && isInsideGitWorkTree(searchPath)) return createGitListBackend();
	if (commandExists("find")) return createPosixFindBackend();
	throw new Error("No file-list backend available: fd could not be resolved and neither `git` nor `find` is on PATH.");
}

function isInsideGitWorkTree(cwd: string): boolean {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	return result.status === 0 && result.stdout.toString().trim() === "true";
}

function createFdBackend(fdPath: string): FileListBackend {
	return {
		name: "fd",
		async run(params) {
			return new Promise((resolve, reject) => {
				if (params.signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const args: string[] = ["--glob", "--color=never", "--hidden"];

				// fd normally ignores .gitignore outside git repos, so keep --no-require-git
				// there. Inside repos, use fd's default git-aware behavior so parent
				// .gitignore rules stop at nested repo boundaries.
				if (!isInsideGitWorkTree(params.searchPath)) args.push("--no-require-git");
				args.push("--max-results", String(params.limit));

				// fd --glob matches against the basename unless --full-path is set; in --full-path
				// mode it matches against the absolute candidate path, so a path-containing
				// pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
				let effectivePattern = params.pattern;
				if (params.pattern.includes("/")) {
					args.push("--full-path");
					if (!params.pattern.startsWith("/") && !params.pattern.startsWith("**/") && params.pattern !== "**") {
						effectivePattern = `**/${params.pattern}`;
					}
					if (process.platform === "win32") effectivePattern = effectivePattern.replaceAll("/", String.raw`[/\\]`);
				}
				args.push("--", effectivePattern, params.searchPath);

				const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
				const rl = createInterface({ input: child.stdout });
				let stderr = "";
				const lines: string[] = [];
				let aborted = false;
				let settled = false;

				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					rl.close();
					params.signal?.removeEventListener("abort", onAbort);
					fn();
				};
				const stopChild = () => {
					if (!child.killed) child.kill();
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
					lines.push(line);
				});

				child.on("error", (error) => {
					settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
				});
				child.on("close", (code) => {
					if (aborted) {
						settle(() => reject(new Error("Operation aborted")));
						return;
					}
					if (code !== 0 && lines.length === 0) {
						settle(() => reject(new Error(stderr.trim() || `fd exited with code ${code}`)));
						return;
					}
					settle(() => resolve(lines));
				});
			});
		},
	};
}

/**
 * Common driver for null-separated file listings (git ls-files -z, find -print0).
 * Reads the entire stdout, splits on NUL, then applies the caller's glob filter.
 * NUL termination avoids the newline-in-filename edge case that would otherwise
 * silently break parsing.
 */
function runNullSeparatedListing(
	backendName: FindBackendName,
	command: string,
	args: string[],
	options: {
		cwd?: string;
		params: { limit: number; signal?: AbortSignal; searchPath: string; pattern: string };
		accept: (relativeOrAbsolute: string) => string | null;
	},
): Promise<string[]> {
	return new Promise((resolve, reject) => {
		if (options.params.signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = Buffer.alloc(0);
		let stderr = "";
		let aborted = false;
		let settled = false;
		const collected: string[] = [];

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			options.params.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const stopChild = () => {
			if (!child.killed) child.kill();
		};
		const onAbort = () => {
			aborted = true;
			stopChild();
		};
		options.params.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			// Consume complete NUL-terminated records eagerly so we can stop the
			// child as soon as the limit is reached.
			let start = 0;
			while (collected.length < options.params.limit) {
				const idx = buffer.indexOf(0, start);
				if (idx === -1) break;
				const raw = buffer.subarray(start, idx).toString("utf8");
				start = idx + 1;
				const accepted = options.accept(raw);
				if (accepted !== null) collected.push(accepted);
			}
			buffer = buffer.subarray(start);
			if (collected.length >= options.params.limit) stopChild();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			settle(() => reject(new Error(`Failed to run ${backendName}: ${error.message}`)));
		});
		child.on("close", (code) => {
			if (aborted && collected.length < options.params.limit) {
				settle(() => reject(new Error("Operation aborted")));
				return;
			}
			// git ls-files without matches exits 0; find likewise. A non-zero exit
			// after we've already collected results (killed for limit) is expected.
			if (code !== 0 && code !== null && collected.length === 0) {
				settle(() => reject(new Error(stderr.trim() || `${backendName} exited with code ${code}`)));
				return;
			}
			settle(() => resolve(collected));
		});
	});
}

function normalizeGlobPattern(pattern: string): string {
	// fd's convention is "no `/` → basename glob"; keep that when post-filtering
	// with minimatch so basename patterns like `*.ts` match at any depth.
	if (pattern === "**" || pattern.startsWith("/")) return pattern;
	if (pattern.startsWith("**/")) return pattern;
	if (!pattern.includes("/")) return `**/${pattern}`;
	return pattern;
}

function createGitListBackend(): FileListBackend {
	return {
		name: "git-ls",
		async run(params) {
			// Search a directory from its own cwd so pathspecs stay relative; when
			// the caller asked about a single file, pin to its parent.
			let cwd = params.searchPath;
			const stat = await fsStat(params.searchPath).catch(() => null);
			if (stat?.isFile()) cwd = path.dirname(params.searchPath);

			const globPattern = normalizeGlobPattern(params.pattern);
			// git ls-files: -c cached, -o others (untracked), --exclude-standard
			// applies .gitignore + .git/info/exclude + core.excludesfile. `-z`
			// keeps filenames with newlines intact.
			const args = ["ls-files", "-c", "-o", "--exclude-standard", "-z", "--", "."];

			return runNullSeparatedListing("git-ls", "git", args, {
				cwd,
				params,
				accept: (relative) => {
					if (!relative) return null;
					if (!minimatch(relative, globPattern, { dot: true })) return null;
					return path.resolve(cwd, relative);
				},
			});
		},
	};
}

function createPosixFindBackend(): FileListBackend {
	return {
		name: "find",
		async run(params) {
			const globPattern = normalizeGlobPattern(params.pattern);
			const args = [params.searchPath, "-type", "f", "-print0"];

			return runNullSeparatedListing("find", "find", args, {
				params,
				accept: (absolute) => {
					if (!absolute) return null;
					const relative = path.relative(params.searchPath, absolute) || path.basename(absolute);
					if (!minimatch(relative, globPattern, { dot: true })) return null;
					return absolute;
				},
			});
		},
	};
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore when fd or git ls-files is available. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: findToolSystemPromptContribution.snippet,
		parameters: findSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
			signal?: AbortSignal,
		) {
			if (signal?.aborted) throw new Error("Operation aborted");

			const searchPath = resolveToCwd(searchDir || ".", cwd);
			const effectiveLimit = limit ?? DEFAULT_LIMIT;
			const ops = customOps ?? defaultFindOperations;

			// Injected custom glob (SSH / VM etc.) still wins, unchanged behavior.
			if (customOps?.glob) {
				if (!(await ops.exists(searchPath))) throw new Error(`Path not found: ${searchPath}`);
				if (signal?.aborted) throw new Error("Operation aborted");
				const results = await ops.glob(pattern, searchPath, {
					ignore: ["**/node_modules/**", "**/.git/**"],
					limit: effectiveLimit,
				});
				if (signal?.aborted) throw new Error("Operation aborted");
				return finalizeOutput(results, searchPath, effectiveLimit, "custom");
			}

			const backend = await selectFileListBackend(searchPath, { agentDir: options?.agentDir });
			if (signal?.aborted) throw new Error("Operation aborted");
			const rawPaths = await backend.run({ pattern, searchPath, limit: effectiveLimit, signal });
			return finalizeOutput(rawPaths, searchPath, effectiveLimit, backend.name);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

function finalizeOutput(
	rawPaths: string[],
	searchPath: string,
	effectiveLimit: number,
	backend: FindBackendName,
): { content: [{ type: "text"; text: string }]; details: FindToolDetails } {
	if (rawPaths.length === 0) {
		return {
			content: [{ type: "text", text: "No files found matching pattern" }],
			details: { backend },
		};
	}

	const relativized: string[] = [];
	for (const rawLine of rawPaths) {
		const line = rawLine.replace(/\r$/, "").trim();
		if (!line) continue;
		relativized.push(relativizeFindResultPath(line, searchPath));
	}

	const resultLimitReached = relativized.length >= effectiveLimit;
	const rawOutput = relativized.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let resultOutput = truncation.content;
	const details: FindToolDetails = { backend };
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(
			`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
		);
		details.resultLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (notices.length > 0) {
		resultOutput += `\n\n[${notices.join(". ")}]`;
	}
	return {
		content: [{ type: "text", text: resultOutput }],
		details,
	};
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
