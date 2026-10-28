/**
 * Small JSON state file under Electron's userData directory.
 *
 * Holds what the shell needs across launches: the window bounds, appearance
 * choice and last folder picked (the default workspace for the next start).
 * Sessions, workspaces and credentials stay where the CLI and web host keep
 * them; this file is never a second source of truth for those.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { DesktopThemeChoice } from "@step-harness/web/desktop-bridge";

export interface WindowState {
	readonly x?: number;
	readonly y?: number;
	readonly width: number;
	readonly height: number;
	readonly maximized: boolean;
}

export interface DesktopState {
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

	/** Keep the current state in memory; return whether it also reached disk. */
	update(patch: Partial<DesktopState>): boolean {
		this.state = { ...this.state, ...patch };
		// An incomplete cache must not replace an unreadable profile, even for an explicit theme change.
		// Saving resumes only in a new store that successfully loads the repaired file.
		if (this.loadFailed) return false;
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const temporary = `${this.path}.${process.pid}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(this.state, null, "\t")}\n`, "utf8");
			renameSync(temporary, this.path);
			return true;
		} catch (error) {
			// Window bounds remain best-effort; preference callers must report a failed save.
			console.warn("stepcode desktop: could not persist state", error);
			return false;
		}
	}

	private load(): DesktopState {
		try {
			const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
				throw new Error("Invalid desktop state");
			}
			const record = raw as Record<string, unknown>;
			const window = parseWindowState(record.window);
			const lastWorkspace = typeof record.lastWorkspace === "string" ? record.lastWorkspace : undefined;
			return {
				...(window === undefined ? {} : { window }),
				...(lastWorkspace === undefined ? {} : { lastWorkspace }),
				...(isDesktopThemeChoice(record.theme) ? { theme: record.theme } : {}),
			};
		} catch (error) {
			const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
			this.loadFailed = !missing;
			return {};
		}
	}
}
