import { open, opendir, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Entries returned for one directory before the listing is cut off. */
export const MAX_DIRECTORY_ENTRIES = 1000;
/** Largest file the preview will load as text. */
export const MAX_PREVIEW_BYTES = 1_000_000;
/**
 * Largest image the raw endpoint will stream: 10 MiB.
 *
 * The page formats sizes with 1024-based units (`lib/format.ts`), so a decimal
 * 10,000,000-byte cap showed a refused file as "9.5 MB" — under the limit it
 * claimed. 10 * 1024 * 1024 makes the number the reader is shown and the number
 * the host enforces the same.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** How many directories a name search may visit before giving up. */
const MAX_SEARCH_DIRECTORIES = 4000;
/** Maximum candidates returned by the composer's workspace file completion. */
export const MAX_FILE_COMPLETIONS = 20;
/** Bound the work of a completion request even in directories containing many files. */
const MAX_COMPLETION_ENTRIES = 20_000;
/** Bytes sniffed to decide whether a file is text. */
const SNIFF_BYTES = 8192;

/**
 * Directories a name search does not descend into. They stay visible and
 * expandable in the tree; walking them would spend the whole search budget on
 * dependency and VCS internals.
 */
const SEARCH_SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".pnpm-store"]);
const COMPLETION_SKIPPED_DIRECTORIES = new Set([
	...SEARCH_SKIPPED_DIRECTORIES,
	"dist",
	"build",
	".next",
	".turbo",
	"target",
]);

const IMAGE_TYPES: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
};

export interface FileTreeEntry {
	readonly name: string;
	/** Path relative to the workspace root, with `/` separators. */
	readonly path: string;
	readonly kind: "directory" | "file";
}

export interface DirectoryListing {
	readonly entries: FileTreeEntry[];
	/** True when the directory holds more entries than were returned. */
	readonly truncated: boolean;
}

export type WorkspaceFile =
	| { readonly kind: "text"; readonly path: string; readonly size: number; readonly content: string }
	| { readonly kind: "image"; readonly path: string; readonly size: number; readonly mimeType: string }
	| { readonly kind: "binary" | "too-large"; readonly path: string; readonly size: number };

function toPosix(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Resolve `inputPath` inside `cwd`, following symlinks on both sides, and refuse
 * anything that lands outside the workspace. Comparing real paths is what stops
 * a symlink inside the workspace from pointing the reader at the rest of the
 * disk.
 */
export async function containedWorkspacePath(cwd: string, inputPath: string): Promise<string> {
	const root = await realpath(cwd);
	const target = await realpath(resolve(root, inputPath || "."));
	const offset = relative(root, target);
	if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
		throw new Error("Path is outside the workspace");
	}
	return target;
}

/** One directory level, directories first. Children load on demand. */
export async function listDirectory(cwd: string, inputPath: string): Promise<DirectoryListing> {
	const root = await realpath(cwd);
	const target = await containedWorkspacePath(root, inputPath);
	const dirents = await readdir(target, { withFileTypes: true });
	const entries = await Promise.all(
		dirents.map(async (dirent) => {
			let directory = dirent.isDirectory();
			if (dirent.isSymbolicLink()) {
				try {
					directory = (await stat(join(target, dirent.name))).isDirectory();
				} catch {
					// A dangling link is listed as a file; opening it reports the error.
				}
			}
			return { name: dirent.name, directory };
		}),
	);
	entries.sort(
		(left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name),
	);
	return {
		entries: entries.slice(0, MAX_DIRECTORY_ENTRIES).map((entry) => ({
			name: entry.name,
			path: toPosix(relative(root, join(target, entry.name))),
			kind: entry.directory ? "directory" : "file",
		})),
		truncated: entries.length > MAX_DIRECTORY_ENTRIES,
	};
}

/** The image MIME type for a path, or undefined when it is not a previewable image. */
export function imageMimeType(path: string): string | undefined {
	return IMAGE_TYPES[extname(path).toLowerCase()];
}

/** A NUL byte in the first block is the same heuristic git uses for "binary". */
function looksBinary(sample: Buffer): boolean {
	return sample.includes(0);
}

/**
 * Read one absolute file for the preview; `path` is the path the client should
 * see (workspace-relative or absolute, depending on the calling scope). Never
 * throws for "cannot show this": images, binaries and oversized files come
 * back as a kind the client renders as a placeholder, so one odd file does not
 * look like a server fault.
 */
async function previewFileAt(target: string, path: string): Promise<WorkspaceFile> {
	const info = await stat(target);
	if (!info.isFile()) throw new Error("Path is not a file");
	const mimeType = imageMimeType(target);
	if (mimeType) {
		// An image the raw endpoint refuses is reported as "too large" rather
		// than handed to the client as a broken <img>: a failed image load
		// carries no status code, so the reader would see no reason at all.
		if (info.size > MAX_IMAGE_BYTES) return { kind: "too-large", path, size: info.size };
		return { kind: "image", path, size: info.size, mimeType };
	}
	if (info.size > MAX_PREVIEW_BYTES) return { kind: "too-large", path, size: info.size };
	const handle = await open(target, "r");
	try {
		const buffer = Buffer.alloc(info.size);
		const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
		const bytes = buffer.subarray(0, bytesRead);
		if (looksBinary(bytes.subarray(0, SNIFF_BYTES))) return { kind: "binary", path, size: info.size };
		return { kind: "text", path, size: info.size, content: bytes.toString("utf8") };
	} finally {
		await handle.close();
	}
}

/** Read a workspace file for the preview, as a path relative to the workspace root. */
export async function readWorkspaceFile(cwd: string, inputPath: string): Promise<WorkspaceFile> {
	const root = await realpath(cwd);
	const target = await containedWorkspacePath(root, inputPath);
	return previewFileAt(target, toPosix(relative(root, target)));
}

/**
 * Normalise a client reference that names a file anywhere on disk. Unlike the
 * workspace routes there is no containment check — the reference itself is the
 * user's own message content, and the host already authenticates every caller.
 */
export async function absoluteLocalPath(inputPath: string): Promise<string> {
	if (!inputPath || /[\u0000-\u001f]/u.test(inputPath) || !isAbsolute(inputPath))
		throw new Error("Path must be absolute");
	return realpath(inputPath);
}

/** Read an absolute path outside any workspace for the preview, named by its own path. */
export async function readLocalFile(inputPath: string): Promise<WorkspaceFile> {
	const target = await absoluteLocalPath(inputPath);
	return previewFileAt(target, toPosix(target));
}

/**
 * Case-insensitive name search below the workspace root, breadth-first so
 * shallow matches win when the result limit is hit. Symlinked directories are
 * not followed: that keeps the walk inside the workspace and free of cycles.
 */
export async function searchWorkspaceFiles(
	cwd: string,
	query: string,
	limit = 200,
): Promise<{ entries: FileTreeEntry[]; truncated: boolean }> {
	const needle = query.trim().toLowerCase();
	if (!needle) return { entries: [], truncated: false };
	const root = await realpath(cwd);
	const entries: FileTreeEntry[] = [];
	const queue = [root];
	let visited = 0;
	while (queue.length) {
		if (visited >= MAX_SEARCH_DIRECTORIES) return { entries, truncated: true };
		const directory = queue.shift() as string;
		visited += 1;
		let dirents: Awaited<ReturnType<typeof readDirents>>;
		try {
			dirents = await readDirents(directory);
		} catch {
			continue;
		}
		for (const dirent of dirents) {
			const absolute = join(directory, dirent.name);
			if (dirent.name.toLowerCase().includes(needle)) {
				if (entries.length >= limit) return { entries, truncated: true };
				entries.push({
					name: dirent.name,
					path: toPosix(relative(root, absolute)),
					kind: dirent.isDirectory() ? "directory" : "file",
				});
			}
			if (dirent.isDirectory() && !SEARCH_SKIPPED_DIRECTORIES.has(dirent.name)) queue.push(absolute);
		}
	}
	return { entries, truncated: false };
}

/** Lower scores prefer exact names, prefixes, substrings, then in-order fuzzy matches. */
function completionScore(name: string, path: string, query: string): number | null {
	const lowerName = name.toLowerCase();
	if (lowerName === query) return 0;
	if (lowerName.startsWith(query)) return 1;
	if (lowerName.includes(query)) return 2;
	if (path.toLowerCase().includes(query)) return 3;
	let cursor = 0;
	let gaps = 0;
	for (const character of query) {
		const next = lowerName.indexOf(character, cursor);
		if (next === -1) return null;
		gaps += next - cursor;
		cursor = next + character.length;
	}
	return 4 + gaps / Math.max(1, lowerName.length);
}

/**
 * Candidates for an `@` path relative to a known workspace. An empty basename
 * lists one directory level; other queries search below that directory. Results
 * are ranked before the limit is applied. Dependency/build directories are not
 * walked unless explicitly scoped, and symlinked directories are never walked
 * recursively. Outside or dangling symlinks cannot become references.
 * Cancellation stops the walk; `truncated` also reports an exhausted walk budget
 * or an unreadable descendant, rather than claiming a complete empty search.
 */
export async function completeWorkspaceFiles(
	cwd: string,
	query: string,
	signal?: AbortSignal,
): Promise<DirectoryListing> {
	signal?.throwIfAborted();
	if (query.length > 1024 || /[\u0000-\u001f\u007f"]/.test(query)) throw new Error("Invalid file completion query");
	const normalized = query.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
	if (/^(\/|~|[a-zA-Z]:)/.test(normalized) || normalized.split("/").includes("..")) {
		throw new Error("Path is outside the workspace");
	}
	const slash = normalized.lastIndexOf("/");
	const scope = slash < 0 ? "" : normalized.slice(0, slash);
	const needle = normalized.slice(slash + 1).toLowerCase();
	const root = await realpath(cwd);
	const queue = [scope];
	const matches: { entry: FileTreeEntry; score: number; depth: number }[] = [];
	let visited = 0;
	let scanned = 0;
	let found = 0;
	let truncated = false;
	const compare = (left: (typeof matches)[number], right: (typeof matches)[number]) =>
		left.score - right.score ||
		left.depth - right.depth ||
		Number(right.entry.kind === "directory") - Number(left.entry.kind === "directory") ||
		left.entry.path.length - right.entry.path.length ||
		left.entry.path.localeCompare(right.entry.path);

	while (queue.length) {
		signal?.throwIfAborted();
		if (visited >= MAX_SEARCH_DIRECTORIES || scanned >= MAX_COMPLETION_ENTRIES) {
			truncated = true;
			break;
		}
		const current = queue.shift();
		if (current === undefined) break;
		visited += 1;
		try {
			const contained = await containedWorkspacePath(root, current);
			signal?.throwIfAborted();
			// Async iteration closes the handle on completion, budget exhaustion and cancellation.
			const directory = await opendir(contained);
			for await (const dirent of directory) {
				signal?.throwIfAborted();
				if (scanned >= MAX_COMPLETION_ENTRIES) {
					truncated = true;
					break;
				}
				scanned += 1;
				// These names cannot be represented by the quoted @path syntax.
				if (/[\u0000-\u001f\u007f"]/.test(dirent.name) || dirent.name === ".git") continue;
				const path = current ? `${current}/${dirent.name}` : dirent.name;
				let kind: FileTreeEntry["kind"] = dirent.isDirectory() ? "directory" : "file";
				if (dirent.isSymbolicLink()) {
					try {
						const target = await containedWorkspacePath(root, path);
						kind = (await stat(target)).isDirectory() ? "directory" : "file";
					} catch {
						// Outside and dangling links are not usable workspace references.
						continue;
					}
				} else if (!dirent.isDirectory() && !dirent.isFile()) continue;
				const score = needle ? completionScore(dirent.name, path.slice(scope.length), needle) : 0;
				if (score !== null) {
					found += 1;
					matches.push({ entry: { name: dirent.name, path, kind }, score, depth: path.split("/").length });
					matches.sort(compare);
					if (matches.length > MAX_FILE_COMPLETIONS) matches.pop();
				}
				if (needle && dirent.isDirectory() && !COMPLETION_SKIPPED_DIRECTORIES.has(dirent.name)) {
					if (queue.length + visited < MAX_SEARCH_DIRECTORIES) queue.push(path);
					else truncated = true;
				}
			}
		} catch (caught) {
			if (signal?.aborted || visited === 1) throw caught;
			// A disappearing or unreadable descendant leaves a partial search.
			truncated = true;
		}
	}
	signal?.throwIfAborted();
	return { entries: matches.map((match) => match.entry), truncated: truncated || found > MAX_FILE_COMPLETIONS };
}

async function readDirents(directory: string) {
	const dirents = await readdir(directory, { withFileTypes: true });
	return dirents.sort((left, right) => left.name.localeCompare(right.name));
}
