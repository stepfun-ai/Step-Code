/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@step-harness/providers";
import type { AgentSessionEvent } from "../core/agent-session.ts";
import type { AgentSessionRuntimeHost } from "../core/agent-session-runtime.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

interface TerminatingBlock {
	toolName: string;
	reason: string;
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
	if (typeof part !== "object" || part === null) return false;
	const candidate = part as { type?: unknown; text?: unknown };
	return candidate.type === "text" && typeof candidate.text === "string";
}

/**
 * Return the tool name and reason when an event is a tool call that a hook
 * blocked and asked the run to stop on.
 *
 * Ordinary tool errors are recoverable and the model routinely works around
 * them, so reporting every one of them would turn successful runs into
 * failures. `terminate` marks the blocks that actually end the run, which is
 * the case a non-interactive caller cannot otherwise see.
 */
function getTerminatingBlock(event: AgentSessionEvent): TerminatingBlock | undefined {
	if (event.type !== "tool_execution_end" || !event.isError) return undefined;
	const result: unknown = event.result;
	if (typeof result !== "object" || result === null) return undefined;
	const { terminate, content } = result as { terminate?: unknown; content?: unknown };
	if (terminate !== true) return undefined;
	const reason = Array.isArray(content)
		? content
				.filter(isTextPart)
				.map((part) => part.text)
				.join("\n")
				.trim()
		: "";
	return { toolName: event.toolName, reason: reason || "no reason given" };
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntimeHost, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];
	// Tool calls a hook blocked and asked the run to stop on. Without a UI these
	// only reach the model, so a denied call looked like the run doing nothing.
	// Feedback issue-d8b499026f19831c.
	const terminatingBlocks: TerminatingBlock[] = [];

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		const nextSession = runtimeHost.session;
		// Subscribe before bindExtensions: session_start handlers may immediately
		// emit custom messages or start a prompt, and those events belong in the
		// print/JSON stream just as they do in interactive mode.
		unsubscribe?.();
		unsubscribeBackpressure?.();
		session = nextSession;
		unsubscribe = session.subscribe((event) => {
			const block = getTerminatingBlock(event);
			if (block) terminatingBlocks.push(block);
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		unsubscribeBackpressure =
			mode === "json"
				? session.agent.subscribe(async () => {
						await waitForRawStdoutBackpressure();
					})
				: undefined;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		// Extensions have registered by now, so the tool set is final: report any
		// --tools/--exclude-tools name that matches nothing instead of silently
		// ignoring it. Warnings go to stderr to keep the text answer and the JSON
		// event stream on stdout parseable.
		const unknownSelectors = session.getUnknownToolSelectors();
		if (unknownSelectors.tools.length > 0 || unknownSelectors.excludeTools.length > 0) {
			for (const [flag, names] of [
				["--tools", unknownSelectors.tools],
				["--exclude-tools", unknownSelectors.excludeTools],
			] as const) {
				if (names.length > 0) {
					console.error(`Warning: ${flag}: unrecognized tool name(s) ignored: ${names.join(", ")}`);
				}
			}
			console.error(`Available tools: ${unknownSelectors.knownTools.join(", ") || "(none)"}`);
		}

		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await session.prompt(message);
		}

		// Exit-code determination applies to both text and json modes so a failed
		// request or a hook-terminated run reports a non-zero status consistently;
		// only the assistant-text stdout print is text-mode specific. Diagnostics go
		// to stderr, keeping the json event stream on stdout parseable.
		for (const block of terminatingBlocks) {
			console.error(`Blocked ${block.toolName}: ${block.reason}`);
		}
		if (terminatingBlocks.length > 0) exitCode = 1;

		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];

		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
				exitCode = 1;
			} else if (mode === "text") {
				for (const content of assistantMsg.content) {
					if (content.type === "text") {
						writeRawStdout(`${content.text}\n`);
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		// Sweep any detached background children on the normal/error-return path; the
		// signal path already sweeps in its handler before process.exit.
		killTrackedDetachedChildren();
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
