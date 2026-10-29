import { basename, dirname, join, resolve, sep } from "node:path";
import { fail, hash, info, inside, safePath, stable, text } from "./filesystem.ts";
import type { MigrationPaths } from "./paths.ts";
import type { MigrationRuleImpact, MigrationScope } from "./types.ts";

export const RULE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
export interface RuleInspection {
	impact: MigrationRuleImpact;
	blocked: boolean;
}

/** Bounded inspection of the default loader's ancestor rules and nested-worktree deduplication. */
export function ruleImpact(
	paths: MigrationPaths,
	scope: MigrationScope,
	target: string,
	result: string,
): RuleInspection {
	const fingerprints = new Map<string, string | null>();
	const contents = new Map<string, string | undefined>();
	const read = (path: string): string | undefined => {
		if (contents.has(path)) return contents.get(path);
		const content = text(path, true);
		contents.set(path, content);
		fingerprints.set(path, content === undefined ? null : hash(content));
		return content;
	};
	const first = (dir: string, after: boolean): string | undefined => {
		let selected: string | undefined;
		for (const name of RULE_NAMES) {
			const path = join(dir, name);
			const exists = read(path) !== undefined;
			if (!selected && (exists || (after && path === target))) selected = path;
		}
		return selected;
	};
	const shadowedByWorktree = (cwd: string, after: boolean): string | undefined => {
		let current = cwd;
		while (true) {
			const gitPath = join(current, ".git");
			safePath(gitPath);
			const entry = info(gitPath);
			if (entry?.isDirectory()) return undefined;
			if (entry?.isFile()) {
				const declaration = read(gitPath)?.trim();
				if (declaration?.startsWith("gitdir: ")) {
					const gitDir = resolve(current, declaration.slice(8).trim());
					const marker = `${sep}.git${sep}`;
					const markerAt = gitDir.indexOf(marker);
					// Do not follow arbitrary external metadata paths supplied by a project.
					if (markerAt < 0) fail("rule-context-inspection-unsupported");
					const owner = gitDir.slice(0, markerAt);
					if (!inside(owner, current) || owner === current) return undefined;
					if (read(join(gitDir, "HEAD")) === undefined) return undefined;
					const common = read(join(gitDir, "commondir"));
					const commonDir = common === undefined ? gitDir : resolve(gitDir, common.trim());
					if (commonDir !== join(owner, ".git")) return undefined;
					safePath(commonDir);
					if (!info(commonDir)?.isDirectory()) return undefined;
					const selected = first(current, after);
					return selected ? join(owner, basename(selected)) : undefined;
				}
			}
			if (dirname(current) === current) return undefined;
			current = dirname(current);
		}
	};
	const before: string[] = [];
	const after: string[] = [];
	const add = (list: string[], path: string | undefined): void => {
		if (path && !list.includes(path)) list.push(path);
	};
	add(before, first(paths.agent, false));
	add(after, first(paths.agent, true));
	const projects = scope.kind === "project" ? [scope.cwd] : [...paths.projects];
	for (const cwd of projects) {
		const ancestors: string[] = [];
		let current = cwd;
		while (true) {
			ancestors.unshift(current);
			if (dirname(current) === current) break;
			current = dirname(current);
		}
		const priorShadow = shadowedByWorktree(cwd, false);
		const nextShadow = shadowedByWorktree(cwd, true);
		for (const directory of ancestors) {
			const prior = first(directory, false);
			const next = first(directory, true);
			if (prior !== priorShadow) add(before, prior);
			if (next !== nextShadow) add(after, next);
		}
	}
	return {
		impact: {
			before,
			after,
			shadowed: before.filter((path) => !after.includes(path)),
			fingerprint: hash(
				stable({
					fingerprints: [...fingerprints].sort(([a], [b]) => a.localeCompare(b)),
					target,
					result: hash(result),
					scope,
				}),
			),
			backupRequired: read(target) !== undefined,
		},
		blocked: !after.includes(target),
	};
}

export function isDirectRule(paths: MigrationPaths, source: string, scope: MigrationScope): boolean {
	if (scope.kind === "global") return false;
	return ruleImpact(paths, scope, join(scope.cwd, "AGENTS.md"), "").impact.before.includes(source);
}
