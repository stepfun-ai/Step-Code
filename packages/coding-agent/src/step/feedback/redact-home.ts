import { realpathSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Collapse the user's home directory to `~`.
 *
 * A report is read by someone else, so an absolute path leaks the OS user name
 * on every line it appears. Collapsing keeps the path structure an investigator
 * needs (`~/code/app/src/main.ts`) without carrying who the user is.
 *
 * Matching requires a path boundary on both sides. `$HOME` is often a symlinked
 * prefix of a resolved path (`/var/...` inside `/private/var/...`), and matching
 * there would produce `/private~/project`; `/Users/bob2` must not be touched by
 * a `/Users/bob` prefix either.
 */
export function collapseHomePaths(value: string, home?: string): string {
	let output = value;
	for (const candidate of homeSpellings(home ?? homeDirectory())) {
		const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		output = output.replace(new RegExp(`(?<![\\w.~/\\-])${escaped}(?=[\\\\/]|$|["'\\s])`, "gu"), "~");
	}
	return output;
}

/**
 * The home directory as it may appear in a path.
 *
 * macOS resolves `/var` to `/private/var`, so a tool that prints a resolved path
 * names the same directory under a different spelling. Collapsing only the
 * configured spelling would leave that path untouched.
 */
function homeSpellings(home: string): string[] {
	const normalized = home.replace(/[\\/]+$/u, "");
	if (normalized.length < 2) return [];
	const spellings = new Set([normalized]);
	try {
		const resolved = realpathSync(normalized).replace(/[\\/]+$/u, "");
		if (resolved.length >= 2) spellings.add(resolved);
	} catch {
		// A home directory that cannot be resolved is still worth collapsing as given.
	}
	return [...spellings];
}

function homeDirectory(): string {
	try {
		return homedir();
	} catch {
		return "";
	}
}
