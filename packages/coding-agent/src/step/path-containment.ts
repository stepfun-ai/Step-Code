import path from "node:path";

/**
 * True when `candidate` is `root` or lies beneath it.
 *
 * `path.relative` reports the root's direct parent as a bare `".."`, which does
 * not start with `".." + sep`; testing only the prefix therefore let a manifest
 * value of `".."` through as if it were contained.
 */
export function isPathContained(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	if (relative === "") return true;
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
