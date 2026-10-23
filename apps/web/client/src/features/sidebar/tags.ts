import type { CSSProperties } from "react";
import type { TagColor } from "../../i18n";
import type { TagGroup } from "../../state/types";

/**
 * Tag colours in hue-wheel order (red → gray) at one shared lightness/chroma
 * band, so 8px diamonds stay tellable apart in both themes; teal replaces the
 * legacy pink, which sat between red and purple and read as a dim red.
 */
export const TAG_COLORS: Readonly<Record<TagColor, string>> = {
	red: "#E5484D",
	orange: "#F76B15",
	yellow: "#FFB224",
	green: "#46A758",
	teal: "#12A594",
	blue: "#3E63DD",
	purple: "#8E4EC6",
	gray: "#8E9299",
};

export const TAG_COLOR_KEYS = Object.keys(TAG_COLORS) as TagColor[];

/** DataTransfer type a grouped-view row drags its session id under. */
export const SESSION_DRAG_TYPE = "application/x-stepcode-session";

/** Name of the group a tag colour stands for, or "" (legacy `groupName`, 756-758). */
export function groupName(groups: readonly TagGroup[], key: TagColor): string {
	return groups.find((group) => group.key === key)?.name ?? "";
}

/** Inline style carrying a CSS custom property (`--tag-color`, `--group-color`). */
export function cssVar(name: string, value: string): CSSProperties {
	return { [name]: value } as CSSProperties;
}
