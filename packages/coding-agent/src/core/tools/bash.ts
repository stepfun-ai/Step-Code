import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { type AgentTool, ToolExecutionError } from "@step-harness/agent-core";
import { Container, Text, truncateToWidth } from "@step-harness/pi-tui";
import { type Static, Type } from "typebox";
import { keyHint } from "../../render/keybinding-hints.ts";
import { truncateToVisualLines } from "../../render/visual-truncate.ts";
import { theme } from "../../theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	INTERRUPTED_COMMAND_GRACE_MS,
	type ShellConfig,
	spawnShellChild,
	terminateProcessTreeGracefully,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	appendCommandOutputFooter,
	type BashExecutionOutcome,
	type BashExecutionResult,
	type CommandOutputFooter,
	commandOutcome,
	commandOutcomeNotice,
	readCommandOutputFooter,
	splitCommandOutputFooter,
} from "./command-outcome.ts";

export type { BashExecutionOutcome, BashExecutionResult } from "./command-outcome.ts";

import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: [],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	/** Producer-generated display suffix, retained without parsing rendered status text. */
	outputFooter?: CommandOutputFooter;
	/** Observed command outcome, independent of whether the tool invocation failed. */
	execution?: BashExecutionOutcome;
	/** Whether the Step character cap shortened the inline output. */
	stepTruncated?: boolean;
}

/** Tool failure retaining command observations and a complete output reference. */
export class ShellToolError extends ToolExecutionError<BashToolDetails> {
	readonly fullOutputPath: string | undefined;
	readonly details: BashToolDetails;

	constructor(message: string, details: BashToolDetails | undefined, options?: ErrorOptions) {
		super(message, { content: [], details: details ?? {} }, options);
		this.details = this.result.details;
		this.fullOutputPath = details?.fullOutputPath;
	}
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<BashExecutionResult>;
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(
	shellName: string,
	resolveShellConfig: () => ShellConfig,
	agentDir?: string,
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				// The invocation never started; report cancellation as a fact.
				return { exitCode: null, aborted: true, ...(timeout === undefined ? {} : { timeoutSeconds: timeout }) };
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			const child = spawnShellChild(shellConfig, command, {
				cwd,
				env: env ?? getShellEnv(agentDir),
				stdout: "pipe",
				stderr: "pipe",
			});
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			// Stop and timeout send SIGTERM to the process group and escalate to SIGKILL after a
			// grace window, so a shell `trap ... TERM` handler gets to run its own cleanup. The
			// escalation is cancelled once the child actually exits; a late SIGKILL must never land
			// on a reused pid. Re-arming (timeout then abort) replaces the previous escalation
			// instead of leaking it.
			//
			// A foreground command uses a short window: the user pressed Escape, or the deadline
			// already elapsed, so anything longer reads as a hang. The call still waits for the tree
			// to exit, which is where a cleanup handler's time actually goes.
			let cancelEscalation: (() => void) | undefined;
			const stopGracefully = () => {
				if (!child.pid) return;
				cancelEscalation?.();
				cancelEscalation = terminateProcessTreeGracefully(child.pid, INTERRUPTED_COMMAND_GRACE_MS);
			};
			const onAbort = () => {
				stopGracefully();
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						stopGracefully();
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by stopping the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				return {
					exitCode,
					signal: child.signalCode,
					timedOut,
					aborted: signal?.aborted === true,
					...(timeout === undefined ? {} : { timeoutSeconds: timeout }),
				};
			} finally {
				// Disarm a pending escalation first: the process is gone, and its pid may be reused.
				cancelEscalation?.();
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string; agentDir?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath), options?.agentDir);
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/** Agent directory used for the managed binary PATH entry. Defaults to Pi's agent directory. */
	agentDir?: string;
	/** Preserve raw output before a caller applies a smaller character cap. Does not change native truncation. */
	persistOutputAboveChars?: number;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatShellCall(args: { command?: string; timeout?: number } | undefined, prompt: string): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	let commandStatus: string | undefined;
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	const footer = readCommandOutputFooter(result.details?.outputFooter);
	if (!options.isPartial && footer) {
		// The producer declares its own framing, so the status row does not depend
		// on whether a full-output log happens to exist.
		const split = splitCommandOutputFooter(output, footer);
		output = split.body.trimEnd();
		commandStatus = split.status || undefined;
	} else if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (commandStatus) component.addChild(new Text(`\n${theme.fg("error", commandStatus)}`, 0, 0));
	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops =
		options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath, agentDir: options?.agentDir });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const baseContext = { command: resolvedCommand, cwd, env: getShellEnv(options?.agentDir) };
			const spawnContext = spawnHook ? spawnHook(baseContext) : baseContext;
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			/**
			 * @param reserveChars framing that will be appended after the body, so the
			 * Step output cap compares against the text the model actually receives.
			 */
			const finishOutput = async (reserveChars = 0) => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				if (
					!snapshot.truncation.truncated &&
					!snapshot.fullOutputPath &&
					options?.persistOutputAboveChars !== undefined &&
					snapshot.content.length + reserveChars > options.persistOutputAboveChars
				) {
					try {
						const preserved = output.snapshot({ persistFullOutput: true });
						await output.closeTempFile();
						return preserved;
					} catch {
						// Keep the complete in-memory output if this additional spool fails.
						// The downstream cap must not discard text without a usable log.
						return snapshot;
					}
				}
				await output.closeTempFile();
				return snapshot;
			};

			/** Split the body from the declared framing; nothing here concatenates them. */
			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				const body = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				let notice = "";
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						notice = `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						notice = `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						notice = `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				} else if (snapshot.fullOutputPath) {
					details = { fullOutputPath: snapshot.fullOutputPath };
					notice = `\n\n[Full output: ${snapshot.fullOutputPath}]`;
				}
				return { body, details, notice };
			};

			/** Keep the producer framing and the model-visible status in one declaration. */
			const buildFooter = (notice: string, status: string | undefined): CommandOutputFooter | undefined =>
				notice || status ? { notice, status: status ?? "" } : undefined;
			/** The only place that concatenates a body, its notice, and its status. */
			const renderText = (body: string, footer: CommandOutputFooter | undefined) =>
				appendCommandOutputFooter(body, footer);
			/** A failure reason belongs in the footer, where the Step cap cannot cut it. */
			const clampStatus = (text: string): string => (text.length > 120 ? `${text.slice(0, 120)}…` : text);
			const unretainedNotice = (reason: string): string =>
				`Command output could not be retained: ${reason}. Check effects before repeating the command.`;
			/** Keep the truncation warning and its log reference when only storage failed. */
			const unretainedDetails = (snapshot: { truncation: TruncationResult }): BashToolDetails =>
				snapshot.truncation.truncated ? { truncation: snapshot.truncation } : {};

			try {
				let execution: BashExecutionResult;
				try {
					execution = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
				} catch (err) {
					const observed = commandOutcome({ exitCode: null }, timeout, signal?.aborted === true);
					const reason = err instanceof Error ? err.message : String(err);
					const status = observed.aborted
						? "Command aborted"
						: `Command executor failed: ${clampStatus(reason)} Check effects before repeating it.`;
					let snapshot: Awaited<ReturnType<typeof finishOutput>>;
					try {
						snapshot = await finishOutput(status.length + 8);
					} catch (storageError) {
						const storageReason = storageError instanceof Error ? storageError.message : String(storageError);
						const failure = `${status}\n${unretainedNotice(storageReason)}`;
						const fallback = output.snapshot({ persistIfTruncated: true });
						const footer = buildFooter("", failure);
						throw new ShellToolError(
							renderText(fallback.content, footer),
							{ ...unretainedDetails(fallback), execution: observed, outputFooter: footer },
							{ cause: new AggregateError([err, storageError], "Execution and output retention failed") },
						);
					}
					const { body, details, notice } = formatOutput(snapshot, "");
					const footer = buildFooter(notice, status);
					throw new ShellToolError(
						renderText(body, footer),
						{ ...details, execution: observed, outputFooter: footer },
						{
							cause: err,
						},
					);
				}

				const observed = commandOutcome(execution, timeout, signal?.aborted === true);
				const status = commandOutcomeNotice(observed);
				let snapshot: Awaited<ReturnType<typeof finishOutput>>;
				try {
					snapshot = await finishOutput(status ? status.length + 2 : 0);
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					const failure = `${status ? `${status}\n` : ""}${unretainedNotice(reason)}`;
					const fallback = output.snapshot({ persistIfTruncated: true });
					const footer = buildFooter("", failure);
					throw new ShellToolError(
						renderText(fallback.content, footer),
						{ ...unretainedDetails(fallback), execution: observed, outputFooter: footer },
						{ cause: err },
					);
				}
				const { body, details, notice } = formatOutput(snapshot);
				const footer = buildFooter(notice, status);
				// Cancellation stays an invocation failure, and the footer already
				// carries the same sentence the message starts with.
				if (observed.aborted) {
					throw new ShellToolError(renderText(body, footer), {
						...details,
						execution: observed,
						outputFooter: footer,
					});
				}
				return {
					content: [{ type: "text", text: renderText(body, footer) }],
					details: { ...details, execution: observed, outputFooter: footer },
					isError: false,
				};
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatShellCall(args, config.prompt));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "step-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
