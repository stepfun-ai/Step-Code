import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail, hash, info, inside, record, safePath, stable, text } from "./filesystem.ts";
import type { MigrationPaths } from "./paths.ts";
import type { MigrationScope } from "./types.ts";

export interface PluginResourceRoot {
	kind: "skills" | "prompts";
	scope: MigrationScope;
	path: string;
	pluginRoot: string;
}

/** Source scopes default to scanned projects; explicit destination scopes never register sources. */
export function installedPluginResources(paths: MigrationPaths): PluginResourceRoot[] {
	return inspectPluginResources(paths, [
		{ kind: "global" },
		...[...paths.projects].map((cwd) => ({ kind: "project" as const, cwd })),
	]).resources;
}

export function destinationPluginResources(
	paths: MigrationPaths,
	scope: MigrationScope,
): { resources: PluginResourceRoot[]; fingerprint: string } {
	return inspectPluginResources(paths, scope.kind === "project" ? [scope, { kind: "global" }] : [scope], true);
}

/** Read installed declarative resources only; never provision plugins or evaluate their entry points. */
function inspectPluginResources(
	paths: MigrationPaths,
	scopes: MigrationScope[],
	reviewed = false,
): {
	resources: PluginResourceRoot[];
	fingerprint: string;
} {
	const roots = scopes.map((scope) => ({
		path: join(
			scope.kind === "project"
				? join(scope.cwd, paths.configDir)
				: paths.env.STEPCODE_STORAGE_ROOT_DIR?.trim() || join(paths.home, paths.configDir),
			"plugins",
		),
		scope,
	}));
	const controls: unknown[] = [];
	const result: PluginResourceRoot[] = [];
	for (const root of roots) {
		safePath(root.path);
		controls.push([root.path, info(root.path) ? "present" : "missing"]);
		if (!info(root.path)) continue;
		const entries = readdirSync(root.path, { withFileTypes: true });
		controls.push([root.path, entries.map((entry) => entry.name).sort()]);
		if (entries.length > 256) fail("resource-limit");
		for (const entry of entries) {
			if (entry.isSymbolicLink()) fail("unsafe-link");
			if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/u.test(entry.name)) continue;
			const pluginRoot = join(root.path, entry.name);
			const native = text(join(pluginRoot, "step.plugin.json"), true);
			const compatible =
				native === undefined || reviewed
					? text(join(pluginRoot, ".claude-plugin", "plugin.json"), true)
					: undefined;
			controls.push([
				pluginRoot,
				native === undefined ? null : hash(native),
				compatible === undefined ? null : hash(compatible),
			]);
			const raw = native ?? compatible;
			if (raw === undefined) continue;
			let manifest: Record<string, unknown>;
			try {
				manifest = record(JSON.parse(raw));
			} catch {
				return fail("invalid-plugin-config");
			}
			if (typeof manifest.id !== "string" && typeof manifest.name !== "string") fail("invalid-plugin-config");
			for (const field of ["skills", "commands"] as const) {
				const declared = manifest[field] ?? (info(join(pluginRoot, field)) ? [field] : []);
				if (!Array.isArray(declared) || declared.some((value) => typeof value !== "string"))
					fail("invalid-plugin-config");
				for (const value of declared) {
					const path = resolve(pluginRoot, value);
					if (!inside(pluginRoot, path)) fail("unsafe-plugin-path");
					safePath(path);
					result.push({ kind: field === "skills" ? "skills" : "prompts", path, scope: root.scope, pluginRoot });
				}
			}
		}
	}
	return { resources: result, fingerprint: hash(stable(controls)) };
}
