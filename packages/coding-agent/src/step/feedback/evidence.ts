/**
 * Everything a feedback report attaches, gathered once.
 *
 * Both hosts the product ships (the terminal and the CLI's top-level command)
 * call this, so a report filed from either surface carries the same evidence:
 * the session transcript, the full output files it referenced, the host log
 * tail, and the content-free session summary. A host decides only how to ask
 * the user; it never decides what a report contains.
 */

import fs from "node:fs/promises";
import { buildFeedbackSessionBundle, type FeedbackBundleResult, resolveFeedbackSession } from "./bundle.ts";
import { type FeedbackDiagnosticsSelection, readFeedbackDiagnostics } from "./diagnostics.ts";
import { type FeedbackRuntimeFacts, type FeedbackSessionSummary, summarizeSessionFile } from "./session-summary.ts";
import { FEEDBACK_SESSION_RECENCY_WINDOW_MS } from "./types.ts";

export interface FeedbackEvidence {
	bundle?: FeedbackBundleResult;
	diagnostics?: FeedbackDiagnosticsSelection;
	summary?: FeedbackSessionSummary;
	/** The session the summary and bundle describe, when one could be resolved. */
	sessionId?: string;
	sessionFile?: string;
}

export async function prepareFeedbackEvidence(input: {
	storageRootDir: string;
	sessionFile?: string;
	sessionId?: string;
	at?: Date;
	env?: NodeJS.ProcessEnv;
	/** Skip the archive (tests, or a host without a session). */
	withoutBundle?: boolean;
	/** Skip the log excerpt. */
	withoutDiagnostics?: boolean;
	/** Live host state the session file cannot provide. */
	runtime?: FeedbackRuntimeFacts;
	/** Project the report is filed from; a guessed session never leaves it. */
	cwd?: string;
}): Promise<FeedbackEvidence> {
	const at = input.at ?? new Date();
	// Whether the user named a session decides the recency rule below; compute it
	// before resolving, because a resolved file no longer looks guessed.
	const guessed = !input.sessionFile && !input.sessionId;
	const resolved = await resolveFeedbackSession({
		...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.env ? { env: input.env } : {}),
		cwd: input.cwd ?? process.cwd(),
	});
	const bundle = input.withoutBundle
		? undefined
		: await buildFeedbackSessionBundle({
				storageRootDir: input.storageRootDir,
				// Pass the file the summary described: resolving a second time could
				// pick a different session and attach a conversation the report does
				// not describe.
				...(resolved ? { sessionFile: resolved.filePath } : input.sessionId ? { sessionId: input.sessionId } : {}),
				at,
				...(input.env ? { env: input.env } : {}),
				cwd: input.cwd ?? process.cwd(),
				guessedSession: guessed,
			});
	// A guessed session outside the recency window is not this report's
	// conversation: describing it (even without content) would attach the wrong
	// session id. Checked here as well as in the bundle, because a host without a
	// bundle endpoint skips the bundle entirely.
	const stale =
		(bundle?.status === "skipped" && bundle.reason === "stale") ||
		(guessed && resolved && (await isStale(resolved.filePath, at)));
	const summary =
		resolved && !stale
			? await summarizeSessionFile(resolved.filePath, { ...(input.runtime ? { runtime: input.runtime } : {}) })
			: undefined;
	const diagnostics = input.withoutDiagnostics
		? undefined
		: await readFeedbackDiagnostics({ storageRootDir: input.storageRootDir, at });
	return {
		...(bundle ? { bundle } : {}),
		...(diagnostics ? { diagnostics } : {}),
		...(summary ? { summary } : {}),
		...(resolved && !stale ? { sessionId: resolved.sessionId, sessionFile: resolved.filePath } : {}),
	};
}

/** The same window the bundle applies to a guessed session. */
async function isStale(sessionFile: string, at: Date): Promise<boolean> {
	const stats = await fs.stat(sessionFile).catch(() => undefined);
	return stats === undefined || at.getTime() - stats.mtime.getTime() >= FEEDBACK_SESSION_RECENCY_WINDOW_MS;
}
