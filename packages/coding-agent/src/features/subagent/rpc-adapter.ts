/**
 * Rpc child plumbing for Step subagents (S2a): the stdout pre-router that
 * separates protocol frames (command acks, blocking extension UI dialogs,
 * extension errors, the needs-input nag) from Pi session events, and the
 * long-running `--mode rpc --session-id` session wrapper with LF-framed stdin
 * commands, ack correlation, dialog auto-cancel, and turn settlement. The
 * default runner (`runStepSubagentProcess`), the shared event projection
 * (`parseJsonEvent`), and tool registration stay in step-subagent.ts.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	CHILD_MARKER,
	cloneUsage,
	currentStepInvocation,
	emptyUsage,
	isRecordValue,
	MAX_JSON_LINE_BYTES,
	normalizeChildTools,
	parseJsonEvent,
	type StepSubagentRunInput,
	type StepSubagentRunResult,
} from "../step-subagent.ts";
import { WORKFLOW_ACL_ENV } from "../workflow/acl-extension.ts";
import { liveSubagentSessions } from "./lane-lifecycle.ts";

const MAX_STDERR_CHARS = 32_000;

/**
 * Handlers for one child stdout line in rpc mode. Lines are routed by JSON
 * `type` before Pi's session-event projection (`parseJsonEvent`) sees them:
 * command acks, blocking extension UI dialogs, extension errors, and the
 * Step-specific needs-input nag are protocol frames, not session events.
 */
export interface SubagentRpcLineHandlers {
	/** `{"type":"response"}` command acks, correlated by `id`. */
	onResponse?: (response: { id?: string; command?: string; success?: boolean; error?: string }) => void;
	/** `{"type":"extension_ui_request"}` dialogs; blocking ones must be answered or the child hangs. */
	onUiRequest?: (request: { id: string; method: string }) => void;
	/** `{"type":"extension_error"}` diagnostics. */
	onExtensionError?: (message: string) => void;
	/** `{"type":"progress-report"}`: the child wants the parent's attention (needs-input nag). */
	onNeedsInput?: (message: string) => void;
	/** Every other line: Pi session events, same shape as `--mode json` output. */
	onEvent?: (line: string, event: Record<string, unknown>) => void;
}

/** Route one LF-framed stdout line from an rpc-mode child. Oversized or non-JSON lines are dropped. */
export function routeSubagentRpcLine(line: string, handlers: SubagentRpcLineHandlers): void {
	if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return;
	}
	if (!isRecordValue(parsed)) return;
	const type = typeof parsed.type === "string" ? parsed.type : "";
	if (type === "response") {
		handlers.onResponse?.({
			id: typeof parsed.id === "string" ? parsed.id : undefined,
			command: typeof parsed.command === "string" ? parsed.command : undefined,
			success: typeof parsed.success === "boolean" ? parsed.success : undefined,
			error: typeof parsed.error === "string" ? parsed.error : undefined,
		});
		return;
	}
	if (type === "extension_ui_request") {
		if (typeof parsed.id === "string" && typeof parsed.method === "string") {
			handlers.onUiRequest?.({ id: parsed.id, method: parsed.method });
		}
		return;
	}
	if (type === "extension_error") {
		handlers.onExtensionError?.(typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error));
		return;
	}
	if (type === "progress-report") {
		handlers.onNeedsInput?.(typeof parsed.message === "string" ? parsed.message : "");
		return;
	}
	handlers.onEvent?.(line, parsed);
}

/** JSON command written LF-framed to an rpc child's stdin. */
type SubagentRpcCommand = Record<string, unknown> & { type: string; id?: string };

interface SubagentRpcTurn {
	promptId: string;
	input: StepSubagentRunInput;
	current: StepSubagentRunResult;
	aborted: boolean;
	resolve: (result: StepSubagentRunResult) => void;
	cleanup?: () => void;
}

/** A live `--mode rpc` child bound to one subagent session id. */
export interface StepSubagentRpcSession {
	readonly sessionId: string;
	/** True while the child can still accept stdin commands. */
	isAlive(): boolean;
	/** True while a prompt turn is in flight. */
	isTurnActive(): boolean;
	/** Write one JSON command; returns false when the child is gone. */
	send(command: SubagentRpcCommand): boolean;
	/** Send a prompt and resolve when the child's run settles. */
	runTurn(input: StepSubagentRunInput): Promise<StepSubagentRunResult>;
	/** Abort the current run and end stdin so the child exits. */
	stop(): void;
}

/** Blocking dialog methods that hang the child until answered. */
const RPC_UI_DIALOG_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);
const CHILD_EXIT_SIGTERM_MS = 5_000;
const CHILD_EXIT_SIGKILL_MS = 10_000;
const ABORT_SETTLE_GRACE_MS = 5_000;
/**
 * Backstop for a child that stays alive but stops talking. A turn otherwise
 * settles only on `agent_settled`, a failed prompt ack, or child exit, so a
 * wedged child strands its parent forever — and `executeSubagent` waits on
 * every lane, so one wedged lane blocks the whole tool.
 *
 * Measured against child output, not wall clock: the child forwards
 * `message_update` deltas over rpc, so a live generation keeps resetting this.
 * The default is deliberately generous because a long `run_command` is silent
 * while it runs and the bash tool's timeout is agent-supplied and effectively
 * unbounded.
 */
const SUBAGENT_TURN_IDLE_TIMEOUT_MS = 30 * 60_000;

/** Resolve the turn idle budget; `0` (or a bad value) disables the watchdog. */
export function resolveSubagentTurnIdleTimeoutMs(
	raw: string | undefined = process.env.STEP_SUBAGENT_TURN_IDLE_TIMEOUT_MS,
): number {
	if (raw === undefined || raw.trim() === "") return SUBAGENT_TURN_IDLE_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return SUBAGENT_TURN_IDLE_TIMEOUT_MS;
	return Math.floor(parsed);
}

/**
 * Environment for one rpc child.
 *
 * All four kill switches are unconditional: a process we spawned is, by
 * definition, already inside somebody's fan-out, so it must neither fan out
 * again nor hold scheduling authority of its own.
 *
 * `CHILD_MARKER` and `STEP_DISABLE_WORKFLOW` close the fan-out edges. Gating
 * `STEP_DISABLE_WORKFLOW` on `workflowAcl` (a permission payload, not a depth
 * marker) used to leave `subagent -> workflow` open, because the subagent runner
 * passes no ACL and its children were therefore misread as top-level: they
 * inherited an enabled workflow env and each fanned out another wave of agents.
 *
 * `STEP_DISABLE_CRON` and `STEP_DISABLE_GOAL` close the scheduling edge. A child
 * runs in the parent's cwd and inherits its project trust, so a cron extension
 * there attaches to the same `.step-cli/cron/tasks.json`: a durable job that
 * comes due while the child sits idle is steered into the CHILD's session and
 * consumed under the shared lock, so the parent never sees it fire. A goal in a
 * child is the same escape in time rather than space: it keeps requesting
 * continuations after the parent has settled the turn and stopped reading.
 *
 * `WORKFLOW_ACL_ENV` stays conditional and is explicitly set to `undefined` when
 * there is no ACL: Node's `spawn` drops `undefined` values, which clears a value
 * inherited from `process.env` instead of leaking the parent's ACL to the child.
 */
export function buildSubagentChildEnv(input: StepSubagentRunInput): NodeJS.ProcessEnv {
	return {
		...process.env,
		[CHILD_MARKER]: "1",
		STEP_DISABLE_WORKFLOW: "1",
		STEP_DISABLE_CRON: "1",
		STEP_DISABLE_GOAL: "1",
		...(input.workflowAcl
			? { [WORKFLOW_ACL_ENV]: JSON.stringify(input.workflowAcl) }
			: { [WORKFLOW_ACL_ENV]: undefined }),
	};
}

/** Spawn a long-running `--mode rpc --session-id` child for one subagent session. */
export async function createSubagentRpcSession(
	input: StepSubagentRunInput,
	sessionId: string,
): Promise<StepSubagentRpcSession> {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "stepcode-subagent-"));
	const args = ["--mode", "rpc", "--session-id", sessionId];
	const model = input.agent.model ?? input.model;
	if (model) args.push("--model", model);
	if (input.thinkingLevel && !input.agent.model) args.push("--thinking", input.thinkingLevel);
	const tools = normalizeChildTools(input.agent.tools);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));
	if (input.agent.systemPrompt.trim()) {
		const promptPath = path.join(tempDir, "system-prompt.md");
		await writeFile(promptPath, input.agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
		args.push("--append-system-prompt", promptPath);
	}

	const invocation = currentStepInvocation(args);
	const child = spawn(invocation.command, invocation.args, {
		cwd: input.cwd,
		env: buildSubagentChildEnv(input),
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stdoutBuffer = "";
	let turn: SubagentRpcTurn | undefined;
	let idleStderr = "";
	let processError: string | undefined;
	let stdinEnded = false;
	let childExited = false;
	const pendingCommandAcks = new Map<string, string>();
	const exitTimers: Array<ReturnType<typeof setTimeout>> = [];
	const turnIdleTimeoutMs = input.turnIdleTimeoutMs ?? resolveSubagentTurnIdleTimeoutMs();
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const clearIdleWatchdog = (): void => {
		if (!idleTimer) return;
		clearTimeout(idleTimer);
		idleTimer = undefined;
	};

	/** (Re)start the idle budget for the in-flight turn. No-op when disabled. */
	const armIdleWatchdog = (): void => {
		clearIdleWatchdog();
		if (turnIdleTimeoutMs <= 0 || !turn) return;
		const active = turn;
		idleTimer = setTimeout(() => {
			if (turn !== active) return;
			settleTurn((current) => {
				current.exitCode = 1;
				current.stopReason = "error";
				current.errorMessage = `Subagent produced no output for ${Math.round(turnIdleTimeoutMs / 1000)}s; the turn was abandoned`;
				// The child is unresponsive, so end it even for a keep-alive lane
				// rather than leaving it to be reused for the next reply.
				closeStdin();
			});
		}, turnIdleTimeoutMs);
		idleTimer.unref?.();
	};

	/** Any byte from the child counts as progress and resets the idle budget. */
	const noteChildActivity = (): void => {
		if (turn) armIdleWatchdog();
	};

	const appendStderr = (text: string): void => {
		if (turn) {
			const current = turn.current;
			if (current.stderr.length < MAX_STDERR_CHARS) {
				current.stderr += text.slice(0, MAX_STDERR_CHARS - current.stderr.length);
			}
			return;
		}
		if (idleStderr.length < MAX_STDERR_CHARS) {
			idleStderr += text.slice(0, MAX_STDERR_CHARS - idleStderr.length);
		}
	};

	const send = (command: SubagentRpcCommand): boolean => {
		if (childExited || stdinEnded || !child.stdin || child.stdin.destroyed) return false;
		if (typeof command.id === "string") pendingCommandAcks.set(command.id, command.type);
		try {
			// LF-only framing per modes/rpc/jsonl.ts; never CRLF.
			child.stdin.write(`${JSON.stringify(command)}\n`);
			return true;
		} catch {
			return false;
		}
	};

	const dropFromRegistry = (): void => {
		if (liveSubagentSessions.get(sessionId) === handle) liveSubagentSessions.delete(sessionId);
	};

	/** End stdin so the child exits through its own rpc shutdown; escalate if it lingers. */
	const closeStdin = (): void => {
		if (stdinEnded || childExited) return;
		stdinEnded = true;
		dropFromRegistry();
		try {
			child.stdin?.end();
		} catch {
			// The pipe may already be gone; the exit timers below still apply.
		}
		const sigterm = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		}, CHILD_EXIT_SIGTERM_MS);
		const sigkill = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, CHILD_EXIT_SIGKILL_MS);
		sigterm.unref?.();
		sigkill.unref?.();
		exitTimers.push(sigterm, sigkill);
	};

	const settleTurn = (finalize: (current: StepSubagentRunResult, aborted: boolean) => void): void => {
		const active = turn;
		if (!active) return;
		turn = undefined;
		clearIdleWatchdog();
		active.cleanup?.();
		finalize(active.current, active.aborted);
		active.current.updatedAt = Date.now();
		if (!active.input.keepAlive) closeStdin();
		active.current.pendingReply = active.input.keepAlive === true && !childExited && !stdinEnded;
		active.resolve({
			...active.current,
			messages: [...active.current.messages],
			usage: cloneUsage(active.current.usage),
		});
	};

	const handleLine = (line: string): void => {
		routeSubagentRpcLine(line, {
			onResponse: (response) => {
				const commandType = response.id ? pendingCommandAcks.get(response.id) : undefined;
				if (response.id) pendingCommandAcks.delete(response.id);
				if (response.success !== false) return;
				const failure = `rpc ${response.command ?? commandType ?? "command"} failed: ${response.error ?? "unknown error"}`;
				if (turn && response.id === turn.promptId) {
					// Prompt preflight failed: no agent_settled will follow this turn.
					settleTurn((current) => {
						current.exitCode = 1;
						current.stopReason = "error";
						current.errorMessage = failure;
					});
					return;
				}
				appendStderr(`${failure}\n`);
			},
			onUiRequest: (request) => {
				// Auto-cancel blocking dialogs: a headless lane has nobody to answer
				// and the child would hang forever (there is no default timeout).
				if (RPC_UI_DIALOG_METHODS.has(request.method)) {
					send({ type: "extension_ui_response", id: request.id, cancelled: true });
				}
			},
			onExtensionError: (message) => appendStderr(`extension_error: ${message}\n`),
			onNeedsInput: (message) => turn?.input.onNeedsInput?.(message),
			onEvent: (eventLine, event) => {
				const active = turn;
				if (!active) return;
				parseJsonEvent(eventLine, active.current, active.input.onUpdate);
				if (event.type === "agent_settled") {
					// The run (including queued steer/follow_up messages) fully drained.
					settleTurn((current, aborted) => {
						current.exitCode = 0;
						if (aborted) {
							current.stopReason = "aborted";
							current.errorMessage = "Subagent was aborted";
						}
					});
				}
			},
		});
	};

	child.stdout?.on("data", (chunk: Buffer | string) => {
		noteChildActivity();
		stdoutBuffer += chunk.toString();
		if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_JSON_LINE_BYTES * 2) {
			processError = "Subagent emitted an oversized JSON event";
			child.kill("SIGTERM");
			return;
		}
		const lines = stdoutBuffer.split("\n");
		stdoutBuffer = lines.pop() ?? "";
		for (const line of lines) handleLine(line.trimEnd());
	});
	child.stderr?.on("data", (chunk: Buffer | string) => {
		noteChildActivity();
		appendStderr(chunk.toString());
	});
	child.once("error", (error) => {
		processError = error.message;
		childExited = true;
		dropFromRegistry();
		clearIdleWatchdog();
		for (const timer of exitTimers) clearTimeout(timer);
		settleTurn((current) => {
			current.exitCode = 1;
			current.stopReason = "error";
			current.errorMessage = processError;
		});
		void rm(tempDir, { recursive: true, force: true });
	});
	child.once("close", (code) => {
		childExited = true;
		dropFromRegistry();
		clearIdleWatchdog();
		for (const timer of exitTimers) clearTimeout(timer);
		if (stdoutBuffer.trim()) handleLine(stdoutBuffer.trim());
		stdoutBuffer = "";
		settleTurn((current, aborted) => {
			current.exitCode = code ?? 1;
			if (aborted) {
				current.stopReason = "aborted";
				current.errorMessage = "Subagent was aborted";
			} else if (processError) {
				current.stopReason = "error";
				current.errorMessage = processError;
			} else if ((code ?? 1) !== 0 && current.stopReason === undefined) {
				current.stopReason = "error";
				current.errorMessage = current.errorMessage ?? `Subagent exited with code ${code ?? 1}`;
			}
		});
		void rm(tempDir, { recursive: true, force: true });
	});

	const runTurn = (turnInput: StepSubagentRunInput): Promise<StepSubagentRunResult> => {
		if (turn) {
			return Promise.reject(new Error(`Subagent session ${sessionId} already has an active turn`));
		}
		if (childExited || stdinEnded) {
			return Promise.reject(new Error(`Subagent session ${sessionId} is no longer running`));
		}
		return new Promise<StepSubagentRunResult>((resolve) => {
			const promptId = randomUUID();
			const current: StepSubagentRunResult = {
				messages: [],
				// Surface startup stderr (for example the "creating a new session
				// with that id" warning) on the turn that follows it.
				stderr: idleStderr,
				exitCode: -1,
				usage: emptyUsage(),
				model: turnInput.agent.model ?? turnInput.model,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			};
			idleStderr = "";
			const active: SubagentRpcTurn = {
				promptId,
				input: turnInput,
				current,
				aborted: turnInput.signal?.aborted === true,
				resolve,
			};
			turn = active;
			if (active.aborted) {
				settleTurn((result) => {
					result.exitCode = 0;
					result.stopReason = "aborted";
					result.errorMessage = "Subagent was aborted";
				});
				return;
			}
			const onAbort = (): void => {
				if (turn !== active || active.aborted) return;
				active.aborted = true;
				// Abort the run inside the child rather than killing the process; a
				// keep-alive lane child stays usable for the next reply.
				send({ type: "abort", id: randomUUID() });
				if (!turnInput.keepAlive) closeStdin();
				const grace = setTimeout(() => {
					if (turn === active) {
						settleTurn((result) => {
							result.exitCode = 0;
							result.stopReason = "aborted";
							result.errorMessage = "Subagent was aborted";
						});
					}
				}, ABORT_SETTLE_GRACE_MS);
				grace.unref?.();
				exitTimers.push(grace);
			};
			if (turnInput.signal) {
				turnInput.signal.addEventListener("abort", onAbort, { once: true });
				active.cleanup = () => turnInput.signal?.removeEventListener("abort", onAbort);
			}
			if (!send({ type: "prompt", id: promptId, message: turnInput.task })) {
				settleTurn((result) => {
					result.exitCode = 1;
					result.stopReason = "error";
					result.errorMessage = "Failed to write the task to the subagent's stdin";
				});
				return;
			}
			armIdleWatchdog();
		});
	};

	const handle: StepSubagentRpcSession = {
		sessionId,
		isAlive: () => !childExited && !stdinEnded,
		isTurnActive: () => turn !== undefined,
		send,
		runTurn,
		stop: () => {
			if (turn) turn.aborted = true;
			send({ type: "abort", id: randomUUID() });
			closeStdin();
		},
	};
	liveSubagentSessions.set(sessionId, handle);
	return handle;
}
