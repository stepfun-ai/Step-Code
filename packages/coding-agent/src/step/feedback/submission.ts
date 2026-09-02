import { randomUUID } from "node:crypto";
import { redactSecretString } from "../secret-redaction.ts";
import { resolveFeedbackContext } from "./context.ts";
import type { FeedbackDiagnostics, FeedbackSubmission } from "./types.ts";
import { redactFeedbackDiagnostics, validateFeedbackInput } from "./validate.ts";

export type BuildFeedbackSubmissionResult = { ok: true; submission: FeedbackSubmission } | { ok: false; error: string };

export async function buildFeedbackSubmission(input: {
	category?: string;
	comment: string;
	diagnostics?: FeedbackDiagnostics;
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
	return {
		ok: true,
		submission: {
			feedbackId: input.feedbackId ?? randomUUID(),
			...(validation.category ? { category: validation.category } : {}),
			comment: redactSecretString(validation.comment),
			at: (input.at ?? new Date()).toISOString(),
			context: await resolveFeedbackContext({
				storageRootDir: input.storageRootDir,
				...(input.sessionId ? { sessionId: input.sessionId } : {}),
				...(input.uid ? { uid: input.uid } : {}),
				...(input.username ? { username: input.username } : {}),
				...(input.env ? { env: input.env } : {}),
			}),
			...(diagnostics ? { diagnostics } : {}),
		},
	};
}
