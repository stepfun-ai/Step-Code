import type { TagColor } from "../i18n/messages";
import type { TagGroup } from "./types";

/**
 * Groups are derived from the sessions that carry their tag.
 *
 * A group is only ever created by tagging a session, and the grouped view stops
 * drawing a group as soon as no active session carries its colour. Keeping the
 * record after that point made the "set group" picker offer a group that no
 * longer exists anywhere else — and its colour stayed taken, so it could not be
 * reused for a new group either. Anything that removes a session or a tag
 * therefore prunes: a group lives exactly as long as a listed session carries
 * it, and a tag for a session that is no longer listed is stale.
 *
 * The group filter is part of the same projection: filtering by a group that has
 * just been removed would hide every row with no way back.
 */
export interface TagGroupState {
	readonly groups: readonly TagGroup[];
	readonly tags: ReadonlyMap<string, TagColor>;
	readonly currentFilter?: TagColor | null;
}

export interface PrunedTagGroups {
	readonly groups: readonly TagGroup[];
	readonly tags: ReadonlyMap<string, TagColor>;
	readonly currentFilter: TagColor | null;
}

/** Keep only tags of `listed` sessions, and only groups some remaining tag still names. */
export function pruneTagGroups(state: TagGroupState, listed: ReadonlySet<string>): PrunedTagGroups {
	const tags = new Map<string, TagColor>();
	for (const [sessionId, color] of state.tags) if (listed.has(sessionId)) tags.set(sessionId, color);
	const used = new Set(tags.values());
	const groups = state.groups.filter((group) => used.has(group.key));
	const filter = state.currentFilter ?? null;
	return {
		groups,
		tags,
		currentFilter: filter && groups.some((group) => group.key === filter) ? filter : null,
	};
}

/** The projection after dropping one session's tag, pruning the group it leaves empty. */
export function withoutSessionTag(state: TagGroupState, sessionId: string): PrunedTagGroups {
	const tags = new Map(state.tags);
	tags.delete(sessionId);
	return pruneTagGroups({ ...state, tags }, new Set(tags.keys()));
}
