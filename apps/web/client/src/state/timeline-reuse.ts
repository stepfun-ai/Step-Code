import type { SessionEntry, SessionSnapshot, TimelineItem, ToolTimelineItem } from "./types";

/**
 * `incoming` folded into `current`, both in branch order. An entry `current`
 * holds deep in the branch is replaced in place (a message re-projected with
 * its saved thinking timings). Entries held at the very end that `incoming`
 * carries again are taken in `incoming`'s order instead: the page appends a
 * completed subagent answer as soon as its event arrives, possibly ahead of an
 * entry recorded before it that the stream had not published yet.
 */
export function mergeEntries(
	current: readonly SessionEntry[],
	incoming: readonly SessionEntry[],
): readonly SessionEntry[] {
	if (!incoming.length) return current;
	const ids = new Set(incoming.map((entry) => entry.id));
	let end = current.length;
	while (end > 0 && ids.has(current[end - 1].id)) end -= 1;
	const kept = current.slice(0, end);
	const positions = new Map(kept.map((entry, index) => [entry.id, index]));
	const merged = [...kept];
	for (const entry of incoming) {
		const index = positions.get(entry.id);
		if (index === undefined) {
			positions.set(entry.id, merged.length);
			merged.push(entry);
		} else merged[index] = entry;
	}
	return merged;
}

/**
 * A snapshot read with `?after=<id>` made whole again from the entries the page
 * holds. A snapshot without `entriesAfter` is already whole. Undefined when the
 * page no longer holds that id (the branch moved under it): read it in full.
 */
export function completeSnapshot(
	snapshot: SessionSnapshot,
	held: readonly SessionEntry[] | undefined,
): SessionSnapshot | undefined {
	const after = snapshot.entriesAfter;
	if (after === undefined) return snapshot;
	const entries = held ?? [];
	let index = entries.length - 1;
	while (index >= 0 && entries[index].id !== after) index -= 1;
	if (index < 0) return undefined;
	const { entriesAfter: _after, ...whole } = snapshot;
	return { ...whole, entries: mergeEntries(entries.slice(0, index + 1), snapshot.entries ?? []) };
}

/** Structural equality of plain timeline data (strings, numbers, arrays, plain objects). */
export function sameData(left: unknown, right: unknown, depth = 0): boolean {
	if (Object.is(left, right)) return true;
	if (!left || !right || typeof left !== "object" || typeof right !== "object" || depth > 12) return false;
	if (Array.isArray(left)) {
		if (!Array.isArray(right) || left.length !== right.length) return false;
		for (let index = 0; index < left.length; index++)
			if (!sameData(left[index], right[index], depth + 1)) return false;
		return true;
	}
	if (Array.isArray(right)) return false;
	const leftKeys = Object.keys(left);
	if (leftKeys.length !== Object.keys(right).length) return false;
	for (const key of leftKeys) {
		if (!Object.hasOwn(right, key)) return false;
		if (!sameData((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth + 1))
			return false;
	}
	return true;
}

/**
 * What a running call's own events added to its row, which its recorded entry
 * cannot know yet: partial output and child links. Per-task subagent progress
 * is not carried, since lane snapshots and completed answers overlay it anew.
 */
function withLiveProgress(next: ToolTimelineItem, previous: ToolTimelineItem): ToolTimelineItem {
	return {
		...next,
		...(next.outputSummary ? {} : { outputSummary: previous.outputSummary }),
		...(next.outputDetail ? {} : { outputDetail: previous.outputDetail }),
		...(next.children?.length || !previous.children?.length ? {} : { children: previous.children }),
		...(next.workflowRun || !previous.workflowRun ? {} : { workflowRun: previous.workflowRun }),
	};
}

/**
 * A rebuilt timeline that reuses every previous row object whose data did not
 * change, so memoised rows skip re-rendering, and keeps the live progress of
 * calls still running (tool_execution_update output, child links) that a
 * rebuild from recorded entries would otherwise drop until the next update.
 */
export function reuseTimelineItems(
	previous: readonly TimelineItem[],
	next: readonly TimelineItem[],
): readonly TimelineItem[] {
	if (!previous.length) return next;
	const byId = new Map<string, TimelineItem>();
	for (const item of previous) if (!byId.has(item.itemId)) byId.set(item.itemId, item);
	let changed = previous.length !== next.length;
	const result = next.map((item, index) => {
		const before = byId.get(item.itemId);
		let candidate = item;
		if (before?.kind === "tool" && item.kind === "tool" && item.state === "pending" && before.state === "pending")
			candidate = withLiveProgress(item, before);
		const reused = before && sameData(before, candidate) ? before : candidate;
		if (reused !== previous[index]) changed = true;
		return reused;
	});
	return changed ? result : previous;
}
