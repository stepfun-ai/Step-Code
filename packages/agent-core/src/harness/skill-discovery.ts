import ignore from "ignore";

/**
 * Ignore rules scoped to one directory in a resource tree. Paths are relative
 * to the scan root, using forward slashes. Callers prune ignored directories
 * before reading child rules, as gitignore requires.
 */
export class SkillIgnoreMatcher {
	private readonly matcher = ignore();
	private readonly prefix: string;
	private readonly parent?: SkillIgnoreMatcher;

	constructor(directory = "", parent?: SkillIgnoreMatcher) {
		this.prefix = directory ? `${directory}/` : "";
		this.parent = parent;
	}

	add(patterns: string): void {
		this.matcher.add(patterns);
	}

	ignores(path: string): boolean {
		const inherited = this.parent?.ignores(path) ?? false;
		if (!path.startsWith(this.prefix)) return inherited;
		const localPath = path.slice(this.prefix.length);
		if (!localPath) return inherited;
		const result = this.matcher.test(localPath);
		if (result.unignored) return false;
		return result.ignored || inherited;
	}
}
