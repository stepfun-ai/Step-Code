/**
 * Small JSON state file under Electron's userData directory.
 *
 * Holds window bounds, appearance, the last picked folder and sidebar group metadata.
 * Group metadata is presentation-only, separate from session persistence.
 * Sessions, workspaces and credentials stay where the CLI and web host keep
 * them; this file is never a second source of truth for those.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
	type DesktopThemeChoice,
	parseTagGroupData,
	TAG_GROUP_DATA_LIMIT,
	type TagGroupData,
} from "@step-harness/web/desktop-bridge";

export interface WindowState {
	readonly x?: number;
	readonly y?: number;
	readonly width: number;
	readonly height: number;
	readonly maximized: boolean;
}

export interface DesktopState {
	readonly tagGroups?: TagGroupData;
	readonly window?: WindowState;
	readonly lastWorkspace?: string;
	readonly theme?: DesktopThemeChoice;
}

/** Validate persisted data and untrusted renderer input against the same theme choices. */
export function isDesktopThemeChoice(value: unknown): value is DesktopThemeChoice {
	return value === "system" || value === "light" || value === "dark" || value === "violet";
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseWindowState(value: unknown): WindowState | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const raw = value as Record<string, unknown>;
	if (!finite(raw.width) || !finite(raw.height) || raw.width < 200 || raw.height < 200) return undefined;
	const positioned = finite(raw.x) && finite(raw.y);
	return {
		...(positioned ? { x: Math.round(raw.x as number), y: Math.round(raw.y as number) } : {}),
		width: Math.round(raw.width),
		height: Math.round(raw.height),
		maximized: raw.maximized === true,
	};
}

export class DesktopStateStore {
	private readonly path: string;
	private state: DesktopState;
	private loadFailed = false;
	private loadError: unknown;
	private pendingPreferences: Partial<Pick<DesktopState, "window" | "lastWorkspace" | "theme">> = {};

	constructor(path: string) {
		this.path = path;
		this.state = this.load();
	}

	get(): DesktopState {
		return this.state;
	}

	/** Read the profile choice, distinguishing a new profile from an unreadable state file. */
	theme(): DesktopThemeChoice | null {
		if (this.loadFailed) throw new Error("Could not read desktop theme");
		return this.state.theme ?? null;
	}

	/** The last picked folder, when it still exists. */
	lastWorkspace(): string | undefined {
		const path = this.state.lastWorkspace;
		if (path === undefined || !isAbsolute(path)) return undefined;
		try {
			return statSync(path).isDirectory() ? path : undefined;
		} catch {
			return undefined;
		}
	}

	/** Retry a failed read without letting preference updates overwrite unreadable metadata. */
	readTagGroups(): TagGroupData | null {
		if (this.loadError !== undefined) this.state = { ...this.load(), ...this.pendingPreferences };
		if (this.loadError !== undefined) throw this.loadError;
		return this.state.tagGroups ? parseTagGroupData(this.state.tagGroups) : null;
	}

	/** Synchronous atomic replacement means an IPC acknowledgement has no outstanding write at close. */
	saveTagGroups(value: unknown): void {
		const tagGroups = parseTagGroupData(value);
		if (this.loadError !== undefined) throw this.loadError;
		this.persist({ ...this.state, tagGroups });
	}

	/** Keep independent preferences in memory; return whether they also reached disk. */
	update(patch: Partial<Pick<DesktopState, "window" | "lastWorkspace" | "theme">>): boolean {
		this.pendingPreferences = { ...this.pendingPreferences, ...patch };
		this.state = { ...this.state, ...patch };
		// An incomplete cache must not replace an unreadable profile, even for an explicit theme change.
		// Only a successful full reload, including group recovery, makes saving safe again.
		if (this.loadError !== undefined) return false;
		try {
			this.persist(this.state);
			return true;
		} catch (error) {
			// Window bounds remain best-effort; theme callers report false and group writes reject.
			console.warn("stepcode desktop: could not persist state", error);
			return false;
		}
	}

	private persist(next: DesktopState): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.tmp`;
		// The metadata limit is measured in compact JSON; formatting must not make an accepted profile unreadable.
		writeFileSync(temporary, `${JSON.stringify(next)}\n`, "utf8");
		renameSync(temporary, this.path);
		this.state = next;
		this.pendingPreferences = {};
	}

	private load(): DesktopState {
		this.loadError = undefined;
		this.loadFailed = false;
		try {
			if (statSync(this.path).size > TAG_GROUP_DATA_LIMIT + 65536) throw new Error("Desktop state is too large");
			const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
				throw new Error("Invalid desktop state");
			}
			const record = raw as Record<string, unknown>;
			const window = parseWindowState(record.window);
			const lastWorkspace = typeof record.lastWorkspace === "string" ? record.lastWorkspace : undefined;
			let tagGroups: TagGroupData | undefined;
			try {
				tagGroups = record.tagGroups === undefined ? undefined : parseTagGroupData(record.tagGroups);
			} catch (error) {
				// Group corruption blocks writes, but independent window/workspace preferences still restore.
				this.loadError = error;
			}
			return {
				...(window === undefined ? {} : { window }),
				...(lastWorkspace === undefined ? {} : { lastWorkspace }),
				...(isDesktopThemeChoice(record.theme) ? { theme: record.theme } : {}),
				...(tagGroups === undefined ? {} : { tagGroups }),
			};
		} catch (error) {
			const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
			this.loadFailed = !missing;
			if (!missing) this.loadError = error;
			return {};
		}
	}
}
