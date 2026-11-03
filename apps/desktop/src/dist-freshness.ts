/**
 * Freshness probes for the workspace packages the desktop server imports.
 *
 * `apps/web` type-checks against `packages/*\/dist`, and `dist/` is git-ignored,
 * so switching branches or pulling can leave declarations older than the
 * sources they were built from. The desktop launcher uses these probes to
 * rebuild only when an output is missing or older than any source file,
 * instead of relying on a manual root `pnpm build`.
 *
 * The check is intentionally mtime-based: every build and every Git checkout
 * rewrites the files it touches, so it catches the practical cases without
 * reading package manifests or hashing sources.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".json", ".html", ".css"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

export interface FreshnessProbe {
	/** Package name or label used in the rebuild log. */
	name: string;
	/** Build outputs that must all exist; the oldest one is the reference. */
	outputs: readonly string[];
	/** Directories scanned recursively for source files. */
	sourceRoots: readonly string[];
}

/** Newest modification time under `root`, or `undefined` when no source file is there. */
export function newestSourceMtimeMs(root: string): number | undefined {
	if (!existsSync(root)) return undefined;

	let newest: number | undefined;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (SKIPPED_DIRECTORIES.has(entry.name)) continue;

		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			const nested = newestSourceMtimeMs(path);
			if (nested !== undefined && (newest === undefined || nested > newest)) newest = nested;
			continue;
		}
		if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name))) continue;

		const { mtimeMs } = statSync(path);
		if (newest === undefined || mtimeMs > newest) newest = mtimeMs;
	}
	return newest;
}

/**
 * Names of probes whose outputs are missing or older than any of their sources.
 * Equal timestamps count as fresh so a build that starts and finishes within
 * one filesystem tick does not trigger another rebuild.
 */
export function staleProbes(probes: readonly FreshnessProbe[]): string[] {
	return probes.filter(probeIsStale).map((probe) => probe.name);
}

function probeIsStale(probe: FreshnessProbe): boolean {
	let oldestOutput: number | undefined;
	for (const output of probe.outputs) {
		if (!existsSync(output)) return true;
		const { mtimeMs } = statSync(output);
		if (oldestOutput === undefined || mtimeMs < oldestOutput) oldestOutput = mtimeMs;
	}

	let newestSource: number | undefined;
	for (const root of probe.sourceRoots) {
		const mtimeMs = newestSourceMtimeMs(root);
		if (mtimeMs !== undefined && (newestSource === undefined || mtimeMs > newestSource)) newestSource = mtimeMs;
	}

	return oldestOutput !== undefined && newestSource !== undefined && newestSource > oldestOutput;
}
