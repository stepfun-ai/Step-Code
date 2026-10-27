import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export interface WebWorkspace {
	readonly path: string;
	readonly name: string;
	/** False when the directory has since been moved or deleted. */
	readonly available: boolean;
	/** Explicitly removed from workspace navigation; sessions remain intact. */
	readonly hidden?: boolean;
}

/** File name of the registry inside the StepCode agent directory. */
export const WORKSPACES_FILE = "web-workspaces.json";

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * One spelling per folder.
 *
 * A folder reaches this registry by more than one name — a symlink, macOS's
 * `/var` and `/private/var`, a trailing slash left by a launcher — and two
 * spellings of one folder are not two workspaces. Removing by one name while
 * the other stayed registered left the workspace listed and usable after it was
 * deleted, so every comparison goes through this.
 *
 * A folder that no longer exists cannot be resolved; its normalized path is the
 * only spelling left, and the entries recorded for it still have to match.
 *
 * Also used for the launch folder a page reports, so `bootstrap.cwd` matches the
 * cwd a session header records and the paths this registry stores.
 */
export async function canonicalWorkspacePath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

/**
 * Folders the user added as workspaces, independent of whether they hold a
 * session yet.
 *
 * Sessions already imply a workspace through their cwd, but that leaves no way
 * to keep an empty folder in the sidebar: it vanishes on reload until the first
 * message is sent. The registry is Web Host metadata only; it never touches
 * session files or the folders themselves.
 */
export class WorkspaceRegistry {
	private readonly file: string;
	private paths: string[] = [];
	private removed: string[] = [];
	private loaded = false;

	constructor(file: string) {
		this.file = file;
	}

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
			const stored = (parsed as { workspaces?: unknown } | null)?.workspaces;
			const removable = (parsed as { removedWorkspaces?: unknown } | null)?.removedWorkspaces;
			const paths: string[] = Array.isArray(stored)
				? unique(stored.filter((entry): entry is string => typeof entry === "string" && !!entry))
				: [];
			const removed: string[] = Array.isArray(removable)
				? unique(removable.filter((entry): entry is string => typeof entry === "string" && isAbsolute(entry)))
				: [];
			// Registered folders are compared canonically, and a removal recorded
			// under another spelling of the same folder still hides it. A file
			// written by the buggy version held both spellings — one visible, one
			// hidden — so this also repairs that state on the next read.
			const canonicalRemoved = await Promise.all(removed.map(canonicalWorkspacePath));
			const canonicalPaths = await Promise.all(paths.map(canonicalWorkspacePath));
			this.removed = unique([...removed, ...canonicalRemoved]);
			this.paths = unique(canonicalPaths).filter((path) => !this.removed.includes(path));
		} catch {
			// Missing or malformed metadata must not stop the host; start empty.
		}
	}

	private async save(): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${process.pid}.tmp`;
		await writeFile(
			temporary,
			`${JSON.stringify({ workspaces: this.paths, removedWorkspaces: this.removed }, null, 2)}\n`,
			"utf8",
		);
		await rename(temporary, this.file);
	}

	async list(): Promise<WebWorkspace[]> {
		await this.load();
		// One entry per folder: a folder recorded under two spellings is hidden
		// once, not listed twice. Removed spellings are kept as the client matches
		// them against the folder names its session rows still carry.
		const paths = unique(this.paths);
		const removed = unique([...this.removed]).filter((path) => !paths.includes(path));
		return Promise.all(
			[...paths, ...removed].map(async (path) => ({
				path,
				name: basename(path) || path,
				available: await isDirectory(path),
				...(removed.includes(path) ? { hidden: true } : {}),
			})),
		);
	}

	async has(path: string): Promise<boolean> {
		await this.load();
		if (!isAbsolute(path)) return false;
		const canonical = await canonicalWorkspacePath(path);
		if (this.removed.includes(canonical)) return false;
		return this.paths.includes(canonical);
	}

	/** Register a folder by its real path, so two spellings cannot list it twice. */
	async add(inputPath: string): Promise<WebWorkspace> {
		await this.load();
		if (!inputPath.trim()) throw new Error("path is required");
		let path: string;
		try {
			path = await realpath(inputPath);
		} catch {
			throw new Error("Folder does not exist");
		}
		if (!(await isDirectory(path))) throw new Error("Path is not a directory");
		// Re-adding restores a removed folder, whichever spelling the removal used.
		const previousPaths = this.paths;
		const previousRemoved = this.removed;
		const restored = await Promise.all(this.removed.map(canonicalWorkspacePath));
		this.removed = this.removed.filter((_entry, index) => restored[index] !== path);
		// Newest first: the folder just added is the one the user wants to see at the top of the sidebar.
		this.paths = [path, ...this.paths.filter((entry) => entry !== path)];
		if (this.removed.length !== previousRemoved.length || this.paths[0] !== previousPaths[0]) {
			try {
				await this.save();
			} catch (error) {
				this.paths = previousPaths;
				this.removed = previousRemoved;
				throw error;
			}
		}
		return { path, name: basename(path) || path, available: true };
	}

	/** Hide registered and session-derived workspaces without touching sessions or files. Idempotent for retries. */
	async remove(path: string): Promise<boolean> {
		await this.load();
		if (!isAbsolute(path)) return false;
		const canonical = await canonicalWorkspacePath(path);
		// Both spellings are recorded. The canonical one owns the registered entry
		// (so the folder cannot stay listed), and the caller's spelling is what the
		// client compares session rows against, which may be another name for the
		// same folder.
		const additions = unique([path, canonical]).filter((entry) => !this.removed.includes(entry));
		if (additions.length === 0) return true;
		const previousPaths = this.paths;
		const previousRemoved = this.removed;
		this.paths = this.paths.filter((entry) => entry !== canonical);
		this.removed = [...this.removed, ...additions];
		try {
			await this.save();
		} catch (error) {
			this.paths = previousPaths;
			this.removed = previousRemoved;
			throw error;
		}
		return true;
	}
}
