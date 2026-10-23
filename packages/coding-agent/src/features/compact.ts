/**
 * `/compact`: one kernel implementation for every host.
 *
 * The command is deliberately small: compaction is a session operation, so the
 * handler only owns what a host cannot know — whether a run is in the way — and
 * leaves both the work and its reporting to the session. Transcript
 * presentation belongs to the host, which sees the resulting `compaction` entry
 * and the `compaction_start` / `compaction_end` events; a refusal ("nothing to
 * compact", "already compacted") arrives as `compaction_end.errorMessage`, so
 * every host reports it once, in its own surface, instead of the command
 * duplicating the terminal's error line.
 */

import type { ExtensionAPI } from "../core/extensions/types.ts";

export const COMPACT_COMMAND_NAME = "compact";

export function createStepCompactExtension(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI): void => {
		pi.registerCommand(COMPACT_COMMAND_NAME, {
			description: "Compact the session context",
			handler: async (args, ctx) => {
				// Compaction aborts the current run before it starts. Refusing here
				// keeps a typed command from silently throwing away a live reply.
				if (!ctx.isIdle()) {
					ctx.ui.notify("Wait for the current run to finish before compacting the context.", "warning");
					return;
				}
				// Returns void and reports through the session's events.
				ctx.compact({ customInstructions: args.trim() || undefined });
			},
		});
	};
}
