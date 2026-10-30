import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface WebWorkspace {
	readonly path: string;
	readonly name: string;
	/** False when the directory has since been moved or deleted. */
	readonly available: boolean;
	/** Explicitly removed from workspace navigation; sessions remain intact. */
	readonly hidden?: boolean;
	/** The first-use workspace the host created (see `initializeDefault`); the page names it "默认工作区". */
	readonly default?: boolean;
}

/** File name of the registry inside the StepCode agent directory. */
export const WORKSPACES_FILE = "web-workspaces.json";

/**
 * Where the first-use workspace lives: `<Documents>/StepCode/default-workspace`.
 * The name is fixed and language-neutral, so one installation keeps one folder
 * on disk whatever language the page is shown in.
 */
export const DEFAULT_WORKSPACE_PARENT = "StepCode";
export const DEFAULT_WORKSPACE_DIRECTORY = "default-workspace";

/**
 * The first-use workspace folder, or undefined when this host must not create
 * one. `STEPCODE_WEB_DOCUMENTS_DIR` names the account's Documents folder; Desktop
 * sets it only when it has no folder to launch in, so a host started in a
 * folder the user chose never creates anything under Documents.
 */
export function firstUseWorkspaceDirectory(env: NodeJS.ProcessEnv): string | undefined {
	const documents = env.STEPCODE_WEB_DOCUMENTS_DIR?.trim();
	if (!documents || !isAbsolute(documents)) return undefined;
	return join(documents, DEFAULT_WORKSPACE_PARENT, DEFAULT_WORKSPACE_DIRECTORY);
}

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
	/** The first-use workspace once created; kept after removal so it is never created again. */
	private defaultPath: string | undefined;
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
			const recordedDefault = (parsed as { defaultWorkspace?: unknown } | null)?.defaultWorkspace;
			if (typeof recordedDefault === "string" && isAbsolute(recordedDefault)) this.defaultPath = recordedDefault;
		} catch {
			// Missing or malformed metadata must not stop the host; start empty.
		}
	}

	private async save(): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${process.pid}.tmp`;
		await writeFile(
			temporary,
			`${JSON.stringify(
				{
					workspaces: this.paths,
					removedWorkspaces: this.removed,
					...(this.defaultPath === undefined ? {} : { defaultWorkspace: this.defaultPath }),
				},
				null,
				2,
			)}\n`,
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
				...(path === this.defaultPath ? { default: true } : {}),
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

	/**
	 * Whether the user removed this folder from workspace navigation. Both
	 * spellings are recorded by `remove`, so either one answers for the folder.
	 * Only removal matters here — a folder that was never registered is left
	 * alone, which is what keeps an untouched launch folder usable.
	 */
	async isRemoved(path: string): Promise<boolean> {
		await this.load();
		if (!isAbsolute(path)) return false;
		const canonical = await canonicalWorkspacePath(path);
		return this.removed.includes(canonical) || this.removed.includes(path);
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
		return {
			path,
			name: basename(path) || path,
			available: true,
			...(path === this.defaultPath ? { default: true } : {}),
		};
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

	/**
	 * Create and register the first-use workspace, once per installation.
	 *
	 * Creation needs a blank installation: no registered or removed workspace and
	 * no session anywhere (`hasSessions`, checked again after the folder is made,
	 * since a session can start meanwhile). An existing user is never moved into
	 * a new folder. Once created the folder is recorded and reused on every later
	 * call; removing it from navigation keeps that record, so it is never created
	 * again, and re-adding the folder makes it the default once more.
	 *
	 * @param directory - absolute folder to create (see `firstUseWorkspaceDirectory`).
	 * @param hasSessions - whether any session exists, live or on disk.
	 * @returns the workspace's real path, or undefined when there is none to use.
	 */
	async initializeDefault(directory: string, hasSessions: () => Promise<boolean>): Promise<string | undefined> {
		await this.load();
		if (this.defaultPath !== undefined) {
			const usable = this.paths.includes(this.defaultPath) && (await isDirectory(this.defaultPath));
			return usable ? this.defaultPath : undefined;
		}
		if (!isAbsolute(directory)) throw new Error(`Default workspace path is not absolute: '${directory}'`);
		if (this.paths.length > 0 || this.removed.length > 0 || (await hasSessions())) return undefined;
		await mkdir(directory, { recursive: true });
		const path = await realpath(directory);
		if (!(await isDirectory(path))) throw new Error(`Default workspace is not a directory: '${path}'`);
		if (this.defaultPath !== undefined || this.paths.length > 0 || (await hasSessions())) return undefined;
		const previousPaths = this.paths;
		this.paths = [path, ...this.paths];
		this.defaultPath = path;
		try {
			await this.save();
		} catch (error) {
			this.paths = previousPaths;
			this.defaultPath = undefined;
			throw error;
		}
		return path;
	}
}

/**
 * The folder new work falls back to when no workspace is on offer, and whether
 * it is a fallback rather than the launch folder itself.
 *
 * `launched` is where the host started (`STEPCODE_WEB_CWD`, else the process
 * cwd), which Desktop sets to the folder the user last picked. That folder is
 * exactly the one a user may have just removed from navigation, and a removed
 * folder is not a target for new work: falling back to it made every "New
 * conversation" with an empty workspace list start in the folder the user had
 * deleted. So a removed launch folder yields `fallback` (the home folder) and
 * reports `fallback: true`, which the page renders as the default project.
 * Re-adding the folder clears the removal and the launch folder is used again.
 */
export interface DefaultWorkspace {
	readonly path: string;
	/** True when `path` is the home fallback because the launch folder was removed. */
	readonly fallback: boolean;
}

export async function resolveDefaultWorkspace(
	registry: WorkspaceRegistry,
	launched: string,
	fallback: string,
): Promise<DefaultWorkspace> {
	const removed = await registry.isRemoved(launched);
	return { path: removed ? fallback : launched, fallback: removed };
}
