import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { resolveStepStorageRoot } from "../storage-root.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "../telemetry.ts";
import { buildFeedbackSessionBundle, describeFeedbackBundle, type FeedbackBundleResult } from "./bundle.ts";
import { neutralizeFeedbackConsentMetadata } from "./consent.ts";
import {
	deliverFeedback,
	describeFeedbackBundleFailure,
	describeFeedbackFailure,
	FEEDBACK_FAILURE_NEXT_STEPS,
	type FeedbackBundleOutcome,
	type FeedbackDeliveryOutcome,
	retryPendingFeedback,
} from "./delivery.ts";
import { readFeedbackDiagnostics } from "./diagnostics.ts";
import { resolveFeedbackEndpoint } from "./endpoints.ts";
import { resolveFeedbackSettings } from "./settings.ts";
import { buildFeedbackSubmission } from "./submission.ts";
import {
	FEEDBACK_CATEGORIES,
	FEEDBACK_CATEGORY_PRESENTATION,
	type FeedbackCategory,
	type FeedbackDiagnostics,
	type FeedbackSubmission,
} from "./types.ts";
import { normalizeFeedbackCategory } from "./validate.ts";

export interface FeedbackCommandDependencies {
	storageRootDir?: string;
	uid?: string;
	username?: string;
	sessionFile?: string;
	sessionId?: string;
	telemetry?: StepTelemetryReporter;
	settings?: { getStepSettings(): { feedbackEnabled?: boolean } };
	fetchImpl?: typeof fetch;
	stdin?: NodeJS.ReadableStream;
	stdout?: NodeJS.WritableStream;
	stderr?: NodeJS.WritableStream;
	env?: NodeJS.ProcessEnv;
	interactive?: boolean;
	prompt?: FeedbackCommandPrompt;
}

export interface FeedbackCommandPrompt {
	question(query: string): Promise<string | undefined>;
}

export interface FeedbackSubmitInput {
	category?: string;
	comment: string;
	diagnostics?: FeedbackDiagnostics;
	sessionId?: string;
	sessionBundle?: FeedbackBundleResult;
	storageRootDir: string;
	uid?: string;
	username?: string;
	endpoint: string;
	bundleEndpoint?: string;
	telemetry?: StepTelemetryReporter;
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	surface: "cli" | "tui";
	confirm?: (submission: FeedbackSubmission) => Promise<boolean>;
}

export type FeedbackSubmitResult =
	| { status: "invalid"; error: string }
	| { status: "cancelled" }
	| { status: "delivered" | "pending"; submission: FeedbackSubmission; outcome: FeedbackDeliveryOutcome };

export function formatFeedbackSubmittedMessage(feedbackId: string): string {
	return `Submitted. Feedback ID: ${feedbackId} — include this ID when contacting support.`;
}

export function formatFeedbackFailureDetails(outcome: Extract<FeedbackDeliveryOutcome, { status: "pending" }>): string {
	const failure = describeFeedbackFailure(outcome);
	if (!outcome.pendingPath) {
		return `${failure} The report body could not be saved locally, so there is no local report copy to retry. ${feedbackWithoutLocalCopyNextStep(outcome.reason)}`;
	}
	return `${failure} Saved to ${outcome.pendingPath}. ${FEEDBACK_FAILURE_NEXT_STEPS[outcome.reason]}`;
}

export function formatFeedbackBundleFailureDetails(
	bundle: Extract<FeedbackBundleOutcome, { status: "pending" }>,
	bodyFailureReason?: Extract<FeedbackDeliveryOutcome, { status: "pending" }>["reason"],
): string {
	const failure = describeFeedbackBundleFailure(bundle);
	if (!bundle.pendingPath) {
		return `${failure} It could not be saved locally either, so there is no local archive to retry. ${feedbackBundleWithoutLocalCopyNextStep(bundle.reason)}`;
	}
	return `${failure} Saved to ${bundle.pendingPath}. ${feedbackBundleNextStep(bundle, bodyFailureReason)}`;
}

export function formatFeedbackPendingDetails(outcome: Extract<FeedbackDeliveryOutcome, { status: "pending" }>): string {
	const bundle = outcome.bundle;
	return `${formatFeedbackFailureDetails(outcome)}${
		bundle?.status === "pending"
			? ` Session archive was not uploaded: ${formatFeedbackBundleFailureDetails(bundle, outcome.reason)}`
			: ""
	}`;
}

export function formatFeedbackBundleSkipMessage(result: Extract<FeedbackBundleResult, { status: "skipped" }>): string {
	switch (result.reason) {
		case "too-large":
			return "The session archive was not included because it remains larger than 8 MiB after trimming.";
		case "stale":
			return "The session archive was not included because the latest session has been inactive for at least 10 minutes. Use --session to select it explicitly.";
		case "empty":
			return "The session archive was not included because the selected session is empty.";
		case "unsafe":
			return "The session archive was not included because credentials could not be safely removed.";
		case "no-session":
			return "The session archive was not included because no matching session was found.";
	}
}

export async function submitFeedback(input: FeedbackSubmitInput): Promise<FeedbackSubmitResult> {
	const built = await buildFeedbackSubmission({
		category: input.category,
		comment: input.comment,
		...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
		storageRootDir: input.storageRootDir,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.uid ? { uid: input.uid } : {}),
		...(input.username ? { username: input.username } : {}),
		...(input.env ? { env: input.env } : {}),
	});
	if (!built.ok) return { status: "invalid", error: built.error };
	const bundle =
		input.sessionBundle?.status === "ready" && input.bundleEndpoint
			? {
					endpoint: input.bundleEndpoint,
					data: input.sessionBundle.bundle.data,
				}
			: undefined;
	if (input.confirm && !(await input.confirm(built.submission))) return { status: "cancelled" };
	const outcome = await deliverFeedback({
		endpoint: input.endpoint,
		submission: built.submission,
		storageRootDir: input.storageRootDir,
		...(bundle ? { bundle } : {}),
		...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
	});
	if (input.telemetry) {
		const uploadedBundle =
			outcome.status === "delivered" && outcome.bundle?.status === "uploaded" ? outcome.bundle : undefined;
		trackStepTelemetry(input.telemetry, "feedback_submitted", {
			category: built.submission.category ?? "",
			has_comment: built.submission.comment.length > 0,
			comment_length_count: [...built.submission.comment].length,
			diagnostics_included: built.submission.diagnostics !== undefined,
			surface: input.surface,
			delivered: outcome.status === "delivered",
			bundle_included: uploadedBundle !== undefined,
			bundle_bytes: uploadedBundle?.bytes ?? 0,
		});
	}
	return { status: outcome.status, submission: built.submission, outcome };
}

export async function runFeedbackCommand(
	argv: readonly string[],
	dependencies: FeedbackCommandDependencies = {},
): Promise<number> {
	const stdout = dependencies.stdout ?? output;
	const stderr = dependencies.stderr ?? process.stderr;
	const stdin = dependencies.stdin ?? input;
	const parsed = parseFeedbackArgs(argv);
	if (parsed.help) {
		write(stdout, feedbackHelp());
		return 0;
	}
	if (parsed.error) {
		write(stderr, `step feedback: ${parsed.error}\n`);
		return 1;
	}
	const env = dependencies.env ?? process.env;
	const settings = dependencies.settings?.getStepSettings();
	const feedbackSettings = resolveFeedbackSettings({ env, settings });
	if (!feedbackSettings.enabled) {
		const reason = feedbackSettings.reason === "env-opt-out" ? "environment setting" : "Step settings";
		write(stderr, `step feedback is disabled by ${reason}\n`);
		return 1;
	}
	const storageRootDir = dependencies.storageRootDir ?? resolveStepStorageRoot(env);
	const endpoint = resolveFeedbackEndpoint(env, false);
	const bundleEndpoint = resolveFeedbackEndpoint(env, true);
	const canPrompt = dependencies.interactive ?? (isTerminal(stdin) && isTerminal(stdout) && !parsed.json);
	if (parsed.retry) {
		if (!endpoint) {
			write(stderr, "step feedback: no feedback endpoint configured\n");
			return 1;
		}
		const results = await retryPendingFeedback({
			endpoint,
			...(bundleEndpoint ? { bundleEndpoint } : {}),
			storageRootDir,
			...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
		});
		const failed = results.filter(
			(result) => result.body?.status === "pending" || result.bundle?.status === "pending",
		);
		if (parsed.json) {
			writeJson(stdout, {
				retried: results.length,
				delivered: results.length - failed.length,
				failed: failed.length,
				results,
			});
		} else {
			write(
				stdout,
				results.length
					? `Re-sent ${results.length - failed.length}/${results.length}\n`
					: "Nothing pending to re-send\n",
			);
			for (const result of failed) {
				if (result.body?.status === "pending") {
					write(stderr, `${result.feedbackId} report body: ${formatFeedbackFailureDetails(result.body)}\n`);
				}
				if (result.bundle?.status === "pending") {
					write(
						stderr,
						`${result.feedbackId} session archive: ${formatFeedbackBundleFailureDetails(
							result.bundle,
							result.body?.status === "pending" ? result.body.reason : undefined,
						)}\n`,
					);
				}
			}
		}
		return failed.length ? 1 : 0;
	}

	if (!endpoint) {
		write(stderr, "step feedback: no feedback endpoint configured\n");
		return 1;
	}
	let category = parsed.category;
	let comment = (parsed.message ?? parsed.positional.join(" ")).trim();
	const hasExplicitComment = parsed.message !== undefined || parsed.positional.length > 0;
	const guided = canPrompt && !hasExplicitComment;
	if (!guided && !category && !comment) {
		write(stderr, "step feedback needs a comment or --category when no interactive terminal is available\n");
		return 1;
	}
	let ownedPrompt: readline.Interface | undefined;
	let prompt: FeedbackCommandPrompt | undefined;
	if (guided) {
		if (dependencies.prompt) prompt = dependencies.prompt;
		else {
			ownedPrompt = readline.createInterface({ input: stdin, output: stdout });
			prompt = ownedPrompt;
		}
	}
	try {
		if (prompt && !category) {
			category = await askCategory(prompt);
			if (!category) {
				write(stdout, "Cancelled; nothing was submitted\n");
				return 0;
			}
		}
		const readAt = new Date();
		const shouldReadDiagnostics =
			parsed.diagnostics === true || (prompt !== undefined && parsed.diagnostics !== false);
		let diagnostics = shouldReadDiagnostics
			? await readFeedbackDiagnostics({ storageRootDir, at: readAt })
			: undefined;
		const shouldBuildBundle =
			bundleEndpoint !== undefined &&
			(parsed.sessionBundle === true || (prompt !== undefined && parsed.sessionBundle !== false));
		let sessionBundle = shouldBuildBundle
			? await buildFeedbackSessionBundle({
					storageRootDir,
					...(!parsed.session && dependencies.sessionFile ? { sessionFile: dependencies.sessionFile } : {}),
					sessionId: parsed.session ?? dependencies.sessionId,
					at: readAt,
					env,
				})
			: undefined;
		if (!parsed.json && sessionBundle?.status === "skipped") {
			write(stdout, `${formatFeedbackBundleSkipMessage(sessionBundle)}\n`);
		}
		if (prompt && parsed.diagnostics === undefined) diagnostics = await askDiagnostics(prompt, diagnostics);
		if (prompt && parsed.sessionBundle === undefined) sessionBundle = await askBundle(prompt, sessionBundle);
		if (prompt) {
			const answer = await prompt.question("Feedback: ");
			if (answer === undefined) {
				write(stdout, "Cancelled; nothing was submitted\n");
				return 0;
			}
			comment = answer;
		}
		const sessionArgumentLooksLikePath =
			parsed.session !== undefined && (/[\\/]/u.test(parsed.session) || /\.jsonl$/iu.test(parsed.session));
		const submissionSessionId = parsed.session
			? sessionBundle?.status === "ready"
				? sessionBundle.bundle.sessionId
				: sessionArgumentLooksLikePath
					? undefined
					: parsed.session
			: dependencies.sessionId;
		const result = await submitFeedback({
			category,
			comment,
			...(diagnostics ? { diagnostics: diagnostics.diagnostics } : {}),
			...(sessionBundle ? { sessionBundle } : {}),
			storageRootDir,
			...(submissionSessionId ? { sessionId: submissionSessionId } : {}),
			...(dependencies.uid ? { uid: dependencies.uid } : {}),
			...(dependencies.username ? { username: dependencies.username } : {}),
			endpoint,
			...(bundleEndpoint ? { bundleEndpoint } : {}),
			telemetry: dependencies.telemetry,
			...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
			env,
			surface: "cli",
			...(prompt
				? {
						confirm: async (submission: FeedbackSubmission) => {
							if (submission.diagnostics && diagnostics) {
								previewDiagnostics(stdout, diagnostics.displayPath, submission.diagnostics);
							}
							previewBundle(stdout, sessionBundle);
							return await confirm(prompt, "Submit feedback? [y/N] ");
						},
					}
				: {}),
		});
		if (result.status === "cancelled") {
			write(stdout, "Cancelled; nothing was submitted\n");
			return 0;
		}
		if (result.status === "invalid") {
			write(stderr, `step feedback: ${result.error}\n`);
			return 1;
		}
		const outcome = result.outcome;
		if (parsed.json) writeJson(stdout, formatSubmitJson(result, sessionBundle));
		else if (outcome.status === "delivered") {
			write(stdout, `${formatFeedbackSubmittedMessage(result.submission.feedbackId)}\n`);
			if (outcome.bundle?.status === "pending") {
				write(
					stderr,
					`  The session archive was not uploaded: ${formatFeedbackBundleFailureDetails(outcome.bundle)}\n`,
				);
			}
		} else {
			write(stderr, `Submission failed: ${formatFeedbackPendingDetails(outcome)}\n`);
		}
		return outcome.status === "delivered" ? 0 : 1;
	} finally {
		ownedPrompt?.close();
	}
}

export function parseFeedbackArgs(argv: readonly string[]): {
	help?: boolean;
	retry?: boolean;
	json?: boolean;
	category?: FeedbackCategory;
	message?: string;
	diagnostics?: boolean;
	sessionBundle?: boolean;
	session?: string;
	positional: string[];
	error?: string;
} {
	const result: ReturnType<typeof parseFeedbackArgs> = { positional: [] };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") result.help = true;
		else if (arg === "--retry") result.retry = true;
		else if (arg === "--json") result.json = true;
		else if (arg === "--diagnostics") result.diagnostics = true;
		else if (arg === "--no-diagnostics") result.diagnostics = false;
		else if (arg === "--session-bundle") result.sessionBundle = true;
		else if (arg === "--no-session-bundle") result.sessionBundle = false;
		else if (arg === "--category" || arg.startsWith("--category=")) {
			const inline = arg.startsWith("--category=");
			const value = inline ? arg.slice("--category=".length) : argv[i + 1];
			if (!value || (!inline && value.startsWith("-"))) {
				result.error ??= "--category requires a value";
				continue;
			}
			if (!inline) i += 1;
			const normalized = normalizeCategory(value);
			if (!normalized) result.error ??= `unknown category '${value}'`;
			else result.category = normalized;
		} else if (arg === "--message" || arg.startsWith("--message=")) {
			const inline = arg.startsWith("--message=");
			const value = inline ? arg.slice("--message=".length) : argv[i + 1];
			if (value === undefined || (!inline && value.startsWith("-"))) {
				result.error ??= "--message requires a value";
				continue;
			}
			if (!inline) i += 1;
			result.message = value;
		} else if (arg === "--session" || arg.startsWith("--session=")) {
			const inline = arg.startsWith("--session=");
			const value = inline ? arg.slice("--session=".length) : argv[i + 1];
			if (!value || (!inline && value.startsWith("-"))) {
				result.error ??= "--session requires a value";
				continue;
			}
			if (!inline) i += 1;
			result.session = value;
		} else if (arg.startsWith("-")) result.error ??= `unknown option '${arg}'`;
		else result.positional.push(arg);
	}
	return result;
}

function normalizeCategory(value: string | undefined): FeedbackCategory | undefined {
	return value ? normalizeFeedbackCategory(value) : undefined;
}

function feedbackHelp(): string {
	return [
		"Usage: step feedback [comment] [options]",
		"",
		"Options:",
		"  --category <name>       bug, bad-result, good-result, safety-check, other",
		"  --message <text>        Feedback comment",
		"  --diagnostics           Attach bounded diagnostics",
		"  --no-diagnostics        Do not attach diagnostics",
		"  --session-bundle         Attach the current session archive",
		"  --no-session-bundle      Do not attach a session archive",
		"  --session <id-or-path>   Session to archive",
		"  --retry                  Retry locally pending feedback",
		"  --json                   Emit JSON only on stdout",
		"  -h, --help               Show this help",
		"",
	].join("\n");
}

async function askCategory(prompt: FeedbackCommandPrompt): Promise<FeedbackCategory | undefined> {
	const choices = FEEDBACK_CATEGORIES.map(
		(category, index) => `${index + 1}. ${FEEDBACK_CATEGORY_PRESENTATION[category].label}`,
	).join(", ");
	for (;;) {
		const answer = await prompt.question(`Category (${choices}): `);
		if (answer === undefined) return undefined;
		const index = Number(answer.trim()) - 1;
		if (Number.isInteger(index) && FEEDBACK_CATEGORIES[index]) return FEEDBACK_CATEGORIES[index];
		const category = normalizeCategory(answer);
		if (category) return category;
	}
}

async function askDiagnostics(
	prompt: FeedbackCommandPrompt,
	candidate: Awaited<ReturnType<typeof readFeedbackDiagnostics>>,
): Promise<Awaited<ReturnType<typeof readFeedbackDiagnostics>>> {
	if (!candidate) return undefined;
	const displayPath = neutralizeFeedbackConsentMetadata(candidate.displayPath);
	return (await confirm(prompt, `Attach diagnostics from ${displayPath}? [Y/n] `, true)) ? candidate : undefined;
}

async function askBundle(
	prompt: FeedbackCommandPrompt,
	candidate: FeedbackBundleResult | undefined,
): Promise<FeedbackBundleResult | undefined> {
	if (!candidate || candidate.status !== "ready") return candidate;
	return (await confirm(prompt, `${describeFeedbackBundle(candidate.bundle)}\nAttach session bundle? [Y/n] `, true))
		? candidate
		: undefined;
}

function previewBundle(stream: NodeJS.WritableStream, candidate: FeedbackBundleResult | undefined): void {
	if (!candidate || candidate.status !== "ready") return;
	write(
		stream,
		`Session bundle (${candidate.bundle.data.byteLength} compressed bytes):\n${describeFeedbackBundle(candidate.bundle)}\n`,
	);
}

async function confirm(prompt: FeedbackCommandPrompt, question: string, defaultValue = false): Promise<boolean> {
	const response = await prompt.question(question);
	if (response === undefined) return false;
	const answer = response.trim();
	return answer.length === 0 ? defaultValue : /^(?:y|yes)$/iu.test(answer);
}

function previewDiagnostics(
	stream: NodeJS.WritableStream,
	displayPath: string,
	diagnostics: FeedbackDiagnostics,
): void {
	const content = diagnostics.lines.join("\n");
	const safeDisplayPath = neutralizeFeedbackConsentMetadata(displayPath);
	write(
		stream,
		`Diagnostics: ${safeDisplayPath} — ${Buffer.byteLength(content, "utf8")} bytes, ${diagnostics.lines.length} lines, truncated: ${diagnostics.truncated ? "yes" : "no"}\n`,
	);
	write(stream, "--- diagnostics begin ---\n");
	write(stream, `${content}\n`);
	write(stream, "--- diagnostics end ---\n");
}

function feedbackBundleNextStep(
	bundle: Extract<FeedbackBundleOutcome, { status: "pending" }>,
	bodyFailureReason?: Extract<FeedbackDeliveryOutcome, { status: "pending" }>["reason"],
): string {
	switch (bundle.reason) {
		case "unreachable":
			return "Run `step feedback --retry` to send it again.";
		case "body-pending":
			if (bodyFailureReason === "too-large" || bodyFailureReason === "rejected") {
				return "Retrying the saved report and archive cannot work; modify and submit the report again, then rebuild its session archive.";
			}
			return bundle.bodyPendingPath
				? `Report body recovery copy: ${bundle.bodyPendingPath}. Run \`step feedback --retry\` to restore the report body and send the archive again.`
				: "The report body was not saved locally. Retrying this archive alone cannot work; rebuild and submit the report and archive together.";
		case "body-missing":
			return bundle.bodyPendingPath
				? `Report body recovery copy: ${bundle.bodyPendingPath}. Run \`step feedback --retry\` to restore the report body and send the archive again.`
				: "The report body was not saved locally. Retrying this archive alone cannot work; rebuild and submit the report and archive together.";
		case "unsupported-endpoint":
			return "Run `step feedback --retry` once the server is upgraded.";
		case "too-large":
			return "Retrying the same archive cannot work; reduce the session data before sending it again.";
		case "rejected":
			return "Retrying the same archive cannot work; check the client version or tell the maintainers.";
	}
}

function feedbackWithoutLocalCopyNextStep(
	reason: Extract<FeedbackDeliveryOutcome, { status: "pending" }>["reason"],
): string {
	switch (reason) {
		case "unreachable":
			return "Keep another copy and submit it again when the collector is reachable.";
		case "unsupported-endpoint":
			return "Submit it again after the server is upgraded.";
		case "too-large":
			return "Shorten the text before sending it again.";
		case "rejected":
			return "Check the client version or tell the maintainers before sending it again.";
	}
}

function feedbackBundleWithoutLocalCopyNextStep(
	reason: Extract<FeedbackBundleOutcome, { status: "pending" }>["reason"],
): string {
	switch (reason) {
		case "unreachable":
		case "body-pending":
		case "body-missing":
			return "The archive must be rebuilt before another upload attempt.";
		case "unsupported-endpoint":
			return "Rebuild it after the server is upgraded.";
		case "too-large":
			return "Reduce the session data before building another archive.";
		case "rejected":
			return "Check the client version or tell the maintainers before building another archive.";
	}
}

function formatSubmitJson(
	result: Extract<FeedbackSubmitResult, { status: "delivered" | "pending" }>,
	sessionBundle?: FeedbackBundleResult,
): Record<string, unknown> {
	const outcome = result.outcome;
	return {
		feedbackId: result.submission.feedbackId,
		category: result.submission.category,
		diagnosticsIncluded: result.submission.diagnostics !== undefined,
		delivered: outcome.status === "delivered",
		...(outcome.status === "pending" ? { error: outcome.reason, pendingPath: outcome.pendingPath } : {}),
		...(outcome.bundle
			? { sessionBundle: outcome.bundle }
			: sessionBundle?.status === "skipped"
				? { sessionBundle }
				: {}),
	};
}

function write(stream: NodeJS.WritableStream, value: string): void {
	stream.write(value);
}

function writeJson(stream: NodeJS.WritableStream, value: unknown): void {
	write(stream, `${JSON.stringify(value)}\n`);
}

function isTerminal(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
	return (stream as { isTTY?: boolean }).isTTY === true;
}
