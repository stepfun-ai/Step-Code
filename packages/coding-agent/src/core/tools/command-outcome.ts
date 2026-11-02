import {
	type CommandExecutionOutcome,
	type CommandExecutionResult,
	commandExecutionNotice,
	normalizeCommandExecution,
	readCommandExecutionOutcome,
} from "@step-harness/agent-core";

export type BashExecutionResult = CommandExecutionResult;
export type BashExecutionOutcome = CommandExecutionOutcome;
// Re-exported so product code and SDK users have one import site; the
// implementation stays in agent-core next to the generic tool that produces it.
export {
	type CommandExecutionOutcome,
	type CommandExecutionResult,
	commandExecutionNotice as commandOutcomeNotice,
	readCommandExecutionOutcome,
} from "@step-harness/agent-core";

export interface CommandOutputFooter {
	/** Producer framing such as a truncation notice; empty when the body has no frame. */
	notice: string;
	/** Trailing status sentence; empty when the command completed cleanly. */
	status: string;
}

/** Validate display framing restored from tool results or session history. */
export function readCommandOutputFooter(value: unknown): CommandOutputFooter | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.notice === "string" && typeof candidate.status === "string"
		? { notice: candidate.notice, status: candidate.status }
		: undefined;
}

/**
 * Append the declared framing to a body.
 *
 * Producers and consumers share this one rule so a declared footer always
 * describes the exact tail of the text. The concatenation is explicit rather
 * than implied by `endsWith`, because an empty body and an empty notice must
 * still agree about where the status starts.
 */
export function appendCommandOutputFooter(body: string, footer: CommandOutputFooter | undefined): string {
	let text = body;
	if (footer?.notice) text = `${text}${footer.notice}`;
	if (footer?.status) text = text ? `${text}\n\n${footer.status}` : footer.status;
	return text;
}

/** Split a rendered command result back into its body and trailing status. */
export function splitCommandOutputFooter(
	text: string,
	footer: CommandOutputFooter | undefined,
): { body: string; status: string } {
	if (!footer) return { body: text, status: "" };
	const candidates: string[] = [];
	if (footer.notice && footer.status) candidates.push(`${footer.notice}\n\n${footer.status}`);
	if (footer.notice) candidates.push(footer.notice);
	if (footer.status) candidates.push(`\n\n${footer.status}`, footer.status);
	for (const suffix of candidates) {
		if (suffix && text.endsWith(suffix)) return { body: text.slice(0, -suffix.length), status: footer.status };
	}
	return { body: text, status: "" };
}

/**
 * Read the command notice a tool result declares, for presentation.
 *
 * An embedded `then_run` reports its check under `details.thenRun`, so a card
 * that only looked at the top level would style an applied edit with a failing
 * check as a clean success.
 */
export function readToolCommandNotice(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const record = details as { execution?: unknown; thenRun?: unknown };
	const observed = readCommandExecutionOutcome(record.execution) ?? readThenRunExecution(record.thenRun);
	return observed ? commandExecutionNotice(observed) : undefined;
}

/**
 * Whether a tool call itself produced a non-success command result.
 *
 * This answers "did the invocation succeed", which is what wire protocols and
 * historical metrics report. A check that fails inside `then_run` is recorded in
 * `details.thenRun` and deliberately does not make the enclosing file mutation
 * look like a failed call.
 */
export function isToolCommandFailure(details: unknown): boolean {
	if (!details || typeof details !== "object") return false;
	const observed = readCommandExecutionOutcome((details as { execution?: unknown }).execution);
	return observed !== undefined && commandExecutionNotice(observed) !== undefined;
}

/**
 * Normalize executor facts for the shell tools.
 *
 * Cancellation wins over a deadline, matching `status`; the individual
 * observations stay in the result so a log or diagnostic can still see them.
 */
export function commandOutcome(
	result: BashExecutionResult,
	timeout: number | undefined,
	aborted: boolean,
): BashExecutionOutcome {
	return normalizeCommandExecution(result, { timeoutSeconds: timeout, aborted });
}

function readThenRunExecution(value: unknown): CommandExecutionOutcome | undefined {
	if (!value || typeof value !== "object") return undefined;
	return readCommandExecutionOutcome((value as { execution?: unknown }).execution);
}
