/**
 * Contract between the Web client and a desktop host (apps/desktop).
 *
 * The desktop preload script exposes an object of this shape as
 * `window.stepcodeDesktop`. In a plain browser the property is absent and the
 * client falls back to browser storage or server-side equivalents. The desktop
 * imports this bounded contract from `@step-harness/web/desktop-bridge`.
 */
export interface StepcodeDesktopBridge {
	/** Claim the current native close/restart intention; null for a manual reload. */
	beginTagGroupClose(): Promise<TagGroupCloseAttempt | null>;
	/** Complete one document-bound intention. False means expired/replaced; never forces destruction. */
	completeTagGroupClose(attemptId: string, outcome: "saved" | "failed"): Promise<boolean>;
	/** Read sidebar group metadata from stable userData storage; rejects on corrupt or unreadable data. */
	readTagGroups(): Promise<TagGroupData | null>;
	/** Save a complete group snapshot. Resolves only after atomic file replacement; rejects on failure. */
	saveTagGroups(data: TagGroupData): Promise<void>;
	/** Host operating system, as reported by Node's `process.platform`. */
	readonly platform: "darwin" | "win32" | "linux";
	/** Desktop application version. */
	readonly version: string;
	/** Saved appearance for this desktop profile, or null when no valid choice was saved. */
	getTheme(): Promise<DesktopThemeChoice | null>;
	/** Persist a theme across server ports and app launches; rejects if the write fails. */
	setTheme(theme: DesktopThemeChoice): Promise<void>;
	/** Open the native folder chooser. Resolves to an absolute path, or null when cancelled. */
	pickDirectory(options?: { readonly title?: string; readonly defaultPath?: string }): Promise<string | null>;
	/** Open an http(s) URL in the system browser. */
	openExternal(url: string): Promise<void>;
	/** Reveal a file or folder in Finder / Explorer / the file manager. */
	revealPath(path: string): Promise<void>;
	/**
	 * The system's default web browser, as `openExternal` would launch it: its display name and a PNG data URL of
	 * its icon (empty when the OS has none). Resolves to null where the OS cannot tell (Linux).
	 */
	defaultBrowser(): Promise<DesktopBrowserInfo | null>;
}

/** Appearance selection, independent of the currently resolved system color scheme. */
export type DesktopThemeChoice = "system" | "light" | "dark" | "violet";

/** Display identity of the system's default browser. */
export interface DesktopBrowserInfo {
	readonly name: string;
	/** `data:image/png;base64,...`, or "" without an icon. */
	readonly icon: string;
}

export interface TagGroupCloseAttempt {
	readonly attemptId: string;
	readonly expiresAt: number;
}

/** Validate the invoke response before granting an unload permit. */
export function parseTagGroupCloseAttempt(value: unknown): TagGroupCloseAttempt | null {
	if (value === null) return null;
	if (
		!record(value) ||
		!boundedText(value.attemptId, 128) ||
		typeof value.expiresAt !== "number" ||
		!Number.isFinite(value.expiresAt)
	)
		throw new Error("Invalid group close attempt");
	return { attemptId: value.attemptId, expiresAt: value.expiresAt };
}

export type GroupColor = "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "gray";

/** Presentation metadata only; never session content or workspace authority. */
export interface TagGroupData {
	readonly version: 1;
	readonly groups: readonly { readonly key: GroupColor; readonly name: string }[];
	readonly tags: readonly (readonly [string, GroupColor])[];
}

export const TAG_GROUP_DATA_LIMIT = 4 * 1024 * 1024;
const GROUP_COLORS: readonly string[] = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "gray"];
function groupColor(value: unknown): value is GroupColor {
	return typeof value === "string" && GROUP_COLORS.includes(value);
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedText(value: unknown, limit: number): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= limit &&
		!/[\u0000-\u001f\u007f]/u.test(value)
	);
}

/** Validate untrusted disk/IPC data and copy only the supported, bounded fields. */
export function parseTagGroupData(value: unknown): TagGroupData {
	if (
		!record(value) ||
		value.version !== 1 ||
		!Array.isArray(value.groups) ||
		!Array.isArray(value.tags) ||
		value.groups.length > GROUP_COLORS.length ||
		value.tags.length > 10000
	) {
		throw new Error("Invalid tag group data");
	}
	const keys = new Set<GroupColor>();
	const names = new Set<string>();
	const groups = value.groups.map((group: unknown) => {
		if (!record(group) || !groupColor(group.key) || !boundedText(group.name, 200) || keys.has(group.key)) {
			throw new Error("Invalid tag group metadata");
		}
		const name = group.name.trim().toLowerCase();
		if (names.has(name)) throw new Error("Duplicate tag group name");
		names.add(name);
		keys.add(group.key);
		return { key: group.key, name: group.name };
	});
	const ids = new Set<string>();
	const used = new Set<GroupColor>();
	const tags = value.tags.map((tag: unknown): readonly [string, GroupColor] => {
		if (
			!Array.isArray(tag) ||
			tag.length !== 2 ||
			!boundedText(tag[0], 256) ||
			!groupColor(tag[1]) ||
			!keys.has(tag[1]) ||
			ids.has(tag[0])
		)
			throw new Error("Invalid tag group assignment");
		ids.add(tag[0]);
		used.add(tag[1]);
		return [tag[0], tag[1]];
	});
	if (groups.some((group) => !used.has(group.key))) throw new Error("Empty tag group metadata");
	const data: TagGroupData = { version: 1, groups, tags };
	if (new TextEncoder().encode(JSON.stringify(data)).length > TAG_GROUP_DATA_LIMIT)
		throw new Error("Tag group data is too large");
	return data;
}

declare global {
	interface Window {
		stepcodeDesktop?: StepcodeDesktopBridge;
	}
}
