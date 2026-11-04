/**
 * Sessions created by the desktop cron scheduler rather than by a user.
 *
 * They live in a separate session directory and never enter the normal
 * history/search/resume paths. The header marker exists so a session can still
 * be recognized when it is opened by id.
 */

export const CRON_SESSION_ORIGIN = "cron";
export const CRON_SESSION_ID_PREFIX = "cron-";

export type SessionOrigin = "subagent" | "cron";

export function isScheduledTaskSession(session: { readonly id: string; readonly origin?: unknown }): boolean {
	return session.origin === CRON_SESSION_ORIGIN || session.id.startsWith(CRON_SESSION_ID_PREFIX);
}
