/**
 * `/ps`: the session's background commands, in the transcript.
 *
 * A background command is the one thing a session can leave running that the transcript does not
 * show. The status line reports a count, but a count cannot tell the user which pid to stop, what a
 * command was, or which one is stuck. This command answers that, in the place a terminal user
 * already reads command output.
 *
 * Deliberately a command rather than a permanent panel: a dev server can run for hours, and a
 * block of always-visible rows would compete with the conversation for the rest of the session.
 * The status line carries the always-on part; this carries the detail on demand.
 *
 * Terminal only. Web and Desktop draw the same list in the composer strip, so the command would
 * duplicate an interface they already have — and worse, `notify` is a no-op in those hosts, so it
 * would look like nothing happened. The handler refuses rather than registering conditionally:
 * `registerCommand` runs once per process and cannot see the host's mode.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../core/extensions/types.ts";
import { listProcesses, type ProcessRegistration, releaseOwnerGracefully } from "../core/process-registry.ts";

/** Commands shown before the list is folded. A long-lived session can accumulate many. */
const MAX_LISTED = 16;

/** First line only, bounded: a row identifies a command, it does not reproduce it. */
function labelOf(entry: ProcessRegistration): string {
	const firstLine = entry.label.trim().split("\n")[0]?.trim() ?? "";
	return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine || "(no command)";
}

/** How long the command has been running, in the compact form a status line uses. */
function elapsedOf(entry: ProcessRegistration, now: number): string {
	const seconds = Math.max(0, Math.floor((now - entry.startedAt) / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

function formatList(entries: readonly ProcessRegistration[], now: number): string {
	if (entries.length === 0) {
		return "Background commands\n\n  No background commands running.";
	}
	const shown = entries.slice(0, MAX_LISTED);
	const lines = shown.map((entry) => {
		const state = entry.releasing ? "stopping" : "running";
		return `  • ${labelOf(entry)}\n    pid ${entry.pid} · ${state} · ${elapsedOf(entry, now)}${
			entry.logPath ? `\n    log ${entry.logPath}` : ""
		}`;
	});
	if (entries.length > shown.length) {
		lines.push(`  ... and ${entries.length - shown.length} more running`);
	}
	return ["Background commands", "", ...lines, "", "Stop one with /ps kill <pid>, or all with /ps kill all."].join(
		"\n",
	);
}

function resolveOwnerId(ctx: ExtensionCommandContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId() || undefined;
	} catch {
		// A context from a replaced session cannot name its owner.
		return undefined;
	}
}

function backgroundCommands(ownerId: string): ProcessRegistration[] {
	return listProcesses(ownerId)
		.filter((entry) => entry.kind === "bash")
		.sort((left, right) => left.startedAt - right.startedAt);
}

export function createStepPsExtension(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI): void => {
		pi.registerCommand("ps", {
			description: "List or stop this session's background commands",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(
						"`/ps` is a terminal command; this host shows background commands in its own interface.",
						"warning",
					);
					return;
				}
				const tokens = args.trim().split(/\s+/u).filter(Boolean);
				const ownerId = resolveOwnerId(ctx);
				if (!ownerId) {
					ctx.ui.notify("This session cannot name its background commands.", "warning");
					return;
				}
				if (tokens[0] === "kill") {
					const target = tokens[1];
					if (!target || tokens.length !== 2) {
						ctx.ui.notify("Usage: /ps kill <pid|all>", "warning");
						return;
					}
					const owned = backgroundCommands(ownerId);
					if (owned.length === 0) {
						ctx.ui.notify("No background commands running.", "info");
						return;
					}
					// Report before waiting, not after: releasing a tree takes the SIGTERM grace window
					// (3s by default), and a command that prints nothing for three seconds reads as
					// ignored. `notify` is captured now because a fork or `/new` during the wait
					// invalidates `ctx`, and a stale context throws on read.
					const notify = (message: string, tone: "info" | "warning" = "info"): void => {
						try {
							ctx.ui.notify(message, tone);
						} catch {
							// The session was replaced mid-wait; the release already happened.
						}
					};
					if (target === "all") {
						// A command already in its grace window is skipped by the registry, so it must be
						// counted as stopping rather than silently reported as zero.
						const stopping = owned.filter((entry) => entry.releasing).length;
						const live = owned.filter((entry) => !entry.releasing);
						if (live.length === 0) {
							notify(`Already stopping ${stopping} background command${stopping === 1 ? "" : "s"}.`);
							return;
						}
						notify(`Stopping ${live.length} background command${live.length === 1 ? "" : "s"}...`);
						const count = await releaseOwnerGracefully(ownerId, undefined, new Set(live.map((e) => e.pid)));
						notify(`Stopped ${count} background command${count === 1 ? "" : "s"}.`);
						return;
					}
					const pid = Number(target);
					if (!Number.isSafeInteger(pid) || pid <= 0) {
						ctx.ui.notify("Usage: /ps kill <pid|all>", "warning");
						return;
					}
					// Scoped by construction: the pid must belong to this session's own commands.
					if (!owned.some((entry) => entry.pid === pid)) {
						ctx.ui.notify(`No background command with pid ${pid} in this session.`, "warning");
						return;
					}
					notify(`Stopping background command ${pid}...`);
					await releaseOwnerGracefully(ownerId, undefined, new Set([pid]));
					notify(`Stopped background command ${pid}.`);
					return;
				}
				if (tokens.length > 0 && tokens[0] !== "list") {
					ctx.ui.notify("Usage: /ps [list|kill <pid|all>]", "warning");
					return;
				}
				ctx.ui.notify(formatList(backgroundCommands(ownerId), Date.now()), "info");
			},
		});
	};
}
