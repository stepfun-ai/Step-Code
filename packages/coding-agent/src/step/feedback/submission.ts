import { randomUUID } from "node:crypto";
import { redactSecretString } from "../secret-redaction.ts";
import { resolveFeedbackContext } from "./context.ts";
import type { FeedbackRequestProvenance, FeedbackSessionSummary } from "./session-summary.ts";
import {
	FEEDBACK_SCHEMA_VERSION,
	type FeedbackDiagnostics,
	type FeedbackSubmission,
	type FeedbackSurface,
} from "./types.ts";
import { redactFeedbackDiagnostics, validateFeedbackInput } from "./validate.ts";

export type BuildFeedbackSubmissionResult = { ok: true; submission: FeedbackSubmission } | { ok: false; error: string };

export async function buildFeedbackSubmission(input: {
	category?: string;
	comment: string;
	diagnostics?: FeedbackDiagnostics;
	sessionSummary?: FeedbackSessionSummary;
	surface?: FeedbackSurface;
	storageRootDir: string;
	sessionId?: string;
	uid?: string;
	username?: string;
	feedbackId?: string;
	at?: Date;
	env?: NodeJS.ProcessEnv;
}): Promise<BuildFeedbackSubmissionResult> {
	const validation = validateFeedbackInput({ category: input.category, comment: input.comment });
	if (!validation.ok) return validation;
	const diagnostics = input.diagnostics ? redactFeedbackDiagnostics(input.diagnostics) : undefined;
	// The request id is repeated at the top level: a collector indexes it without
	// walking the summary, and an older client that sends neither field is still
	// a valid report.
	const request = input.sessionSummary?.request;
	return {
		ok: true,
		submission: {
			schemaVersion: FEEDBACK_SCHEMA_VERSION,
			// A host states its surface; an omitted one stays absent rather than
			// being mislabelled as the CLI.
			...(input.surface ? { surface: input.surface } : {}),
			feedbackId: input.feedbackId ?? randomUUID(),
			...(validation.category ? { category: validation.category } : {}),
			comment: redactSecretString(validation.comment),
			at: (input.at ?? new Date()).toISOString(),
			context: await resolveFeedbackContext({
				storageRootDir: input.storageRootDir,
				...(input.surface ? { surface: input.surface } : {}),
				...(input.sessionId ? { sessionId: input.sessionId } : {}),
				...(input.uid ? { uid: input.uid } : {}),
				...(input.username ? { username: input.username } : {}),
				...(input.env ? { env: input.env } : {}),
			}),
			...(diagnostics ? { diagnostics } : {}),
			...(input.sessionSummary ? { sessionSummary: input.sessionSummary } : {}),
			...(request ? { request } : {}),
		},
	};
}

export type { FeedbackRequestProvenance };
