/**
 * Sessions written by child agents (subagent lanes and workflow agents) rather
 * than by a user. A child runs in the parent's cwd, so its transcript lands in
 * the same per-cwd session directory as the parent's; session lists and search
 * use this to keep to sessions a user started.
 *
 * Two markers identify a child, and either is enough:
 * - `origin: "subagent"` in the session header, written by the child process
 *   when it creates the session (see `childSessionHeader`).
 * - The session id prefix. Every child is spawned through
 *   `runStepSubagentProcess` with an id the parent generates
 *   (`subagent-<uuid>`, `workflow-<runId>-<agentId>`). Sessions written before
 *   the header marker existed carry only this.
 */

export const SUBAGENT_SESSION_ID_PREFIX = "subagent-";
export const WORKFLOW_SESSION_ID_PREFIX = "workflow-";

/** Header `origin` of a session a child agent created. */
export const CHILD_SESSION_ORIGIN = "subagent";

/** True for an id the parent generated for a spawned child agent. */
export function isChildAgentSessionId(sessionId: string): boolean {
	return sessionId.startsWith(SUBAGENT_SESSION_ID_PREFIX) || sessionId.startsWith(WORKFLOW_SESSION_ID_PREFIX);
}

/** True for a session written by a spawned child agent, not by a user. */
export function isChildAgentSession(session: { readonly id: string; readonly origin?: unknown }): boolean {
	return session.origin === CHILD_SESSION_ORIGIN || isChildAgentSessionId(session.id);
}
