import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { SkillIgnoreMatcher } from "@step-harness/agent-core";
import { minimatch } from "minimatch";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { readStepMcpImportReviewedSources } from "../mcp-import-store.ts";
import {
	bytes,
	diagnosticCode,
	fail,
	hash,
	info,
	type PackageFile,
	record,
	safePath,
	stable,
	text,
	tree,
	treeHash,
} from "./filesystem.ts";
import {
	declarations,
	type McpDeclaration,
	mcpIdentity,
	pluginMcpMatches,
	sanitizedMcp,
	targetServers,
} from "./mcp.ts";
import { configDocument, type MigrationPaths } from "./paths.ts";
import { destinationPluginResources, installedPluginResources } from "./plugins.ts";
import { isDirectRule, RULE_NAMES } from "./rules.ts";
import type {
	MigrationCandidate,
	MigrationKind,
	MigrationScanResult,
	MigrationScope,
	MigrationSource,
} from "./types.ts";

export interface ResourceCandidate {
	dto: MigrationCandidate;
	mcp?: McpDeclaration;
	root: string;
	base: string;
}
export function skillMetadata(
	content: string,
	path: string,
): { name: string; body: string; frontmatter: Record<string, unknown> } {
	try {
		const parsed = parseFrontmatter(content);
		const frontmatter = record(parsed.frontmatter);
		if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) fail("invalid-skill");
		const name =
			typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : basename(dirname(path));
		return { name, body: parsed.body, frontmatter };
	} catch {
		return fail("invalid-skill");
	}
}
export function renamedSkill(content: string, path: string, name: string): string {
	const parsed = skillMetadata(content, path);
	const frontmatter = { ...parsed.frontmatter, name };
	// JSON scalars and arrays are valid YAML; preserve all source metadata, changing the logical name only.
	return `---\n${Object.entries(frontmatter)
		.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
		.join("\n")}\n---\n${parsed.body}\n`;
}

function enabled(path: string, patterns: string[], base: string): boolean {
	const values = [
		path,
		relative(base, path),
		basename(path),
		dirname(path),
		relative(base, dirname(path)),
		basename(dirname(path)),
	].map((p) => p.replaceAll("\\", "/"));
	const exact = (p: string): boolean =>
		[path, relative(base, path), dirname(path), relative(base, dirname(path))]
			.map((v) => v.replaceAll("\\", "/"))
			.includes(p.replace(/^\.\//u, ""));
	let result = !patterns.filter((p) => p.startsWith("!")).some((p) => values.some((v) => minimatch(v, p.slice(1))));
	if (patterns.filter((p) => p.startsWith("+")).some((p) => exact(p.slice(1)))) result = true;
	if (patterns.filter((p) => p.startsWith("-")).some((p) => exact(p.slice(1)))) result = false;
	return result;
}
function settingsPatterns(paths: MigrationPaths, scope: MigrationScope): { patterns: string[]; uncertain: boolean } {
	const config = configDocument(paths.configFor(scope));
	const value = config.skills;
	if (value !== undefined && (!Array.isArray(value) || value.some((p) => typeof p !== "string")))
		fail("invalid-target-config");
	const patterns: string[] = Array.isArray(value) ? value : [];
	return {
		patterns,
		uncertain:
			patterns.some((p) => !/^[!+-]/u.test(p)) || (Array.isArray(config.packages) && config.packages.length > 0),
	};
}

export function copiedSkillEnabled(files: PackageFile[]): boolean {
	const matcher = new SkillIgnoreMatcher();
	for (const file of files)
		if ([".gitignore", ".ignore", ".fdignore"].includes(file.path)) matcher.add(file.data.toString("utf8"));
	return !matcher.ignores("SKILL.md");
}

export function targetResourceUncertain(paths: MigrationPaths, scope: MigrationScope): boolean {
	return settingsPatterns(paths, scope).uncertain;
}

export function targetResourceEnabled(paths: MigrationPaths, scope: MigrationScope, path: string): boolean {
	return (
		enabled(path, settingsPatterns(paths, scope).patterns, paths.resourceRoot(scope)) &&
		!settingsPatterns(paths, scope).uncertain &&
		!skillIgnored(join(paths.resourceRoot(scope), "skills"), path)
	);
}

/** Ignore content is part of consent even when an edit leaves the enabled outcome unchanged. */
export function resourceIgnoreFingerprint(root: string, path: string): string {
	const rules: (string | null)[] = [];
	let current = root;
	const directories = [root];
	for (const part of relative(root, dirname(path)).split(/[\\/]/u).filter(Boolean)) {
		current = join(current, part);
		directories.push(current);
	}
	for (const directory of directories)
		for (const name of [".gitignore", ".ignore", ".fdignore"]) rules.push(text(join(directory, name), true) ?? null);
	return hash(stable(rules));
}

export class ResourceInspector {
	readonly paths: MigrationPaths;
	constructor(paths: MigrationPaths) {
		this.paths = paths;
	}
	scan(kinds: MigrationKind[]): { result: MigrationScanResult; records: ResourceCandidate[] } {
		const result: MigrationScanResult = { candidates: [], sources: [], truncated: false };
		const records: ResourceCandidate[] = [];
		// On case-insensitive filesystems AGENTS.md and AGENTS.MD are one file; list it once.
		const ruleFiles = new Set<string>();
		const cliReviewed = kinds.includes("mcp") ? this.cliReviewedMcpSources() : undefined;
		const add = (
			kind: MigrationKind,
			source: MigrationSource,
			scope: MigrationScope,
			root: string,
			base = dirname(root),
		): void => {
			if (!kinds.includes(kind)) return;
			const report: MigrationScanResult["sources"][number] = {
				kind,
				source,
				scope,
				path: root,
				status: "empty",
				diagnostics: [],
			};
			result.sources.push(report);
			if (kind === "mcp" && cliReviewed?.has(source)) {
				// The CLI's first-run review already offered this source; the web wizard does not ask again.
				report.status = "ok";
				report.diagnostics.push({ code: "mcp-reviewed-by-cli" });
				return;
			}
			try {
				safePath(root);
				if (!info(root)) {
					report.status = "missing";
					return;
				}
				let files: { path: string; mcp?: McpDeclaration }[];
				if (kind === "mcp")
					files = declarations(root, source, (count) => {
						report.status = "unsupported";
						report.diagnostics.push({ code: "project-mcp-source-unsupported", count });
					}).map((mcp) => ({ path: root, mcp }));
				else if (kind === "rules") files = [{ path: root }];
				// (rule dedupe happens per candidate below)
				else if (info(root)?.isFile()) files = [{ path: root }];
				else files = this.discover(root, kind === "skills", source === "claude-code" || source === "codex");
				for (const file of files) {
					if (records.length >= 2000) {
						result.truncated = true;
						break;
					}
					if (kind === "rules") {
						// Identity by device+inode: AGENTS.md and AGENTS.MD are one file on a
						// case-insensitive volume, and realpath alone does not collapse them.
						let identity: string;
						try {
							const stats = statSync(file.path);
							identity = `${stats.dev}:${stats.ino}`;
						} catch {
							identity = `path:${file.path}`;
						}
						if (ruleFiles.has(identity)) continue;
						ruleFiles.add(identity);
					}
					const dto: MigrationCandidate = {
						id: hash(`${kind}\0${file.path}\0${file.mcp?.name ?? ""}\0${stable(scope)}`),
						kind,
						source,
						name:
							file.mcp?.name ??
							(kind === "skills"
								? basename(dirname(file.path))
								: relative(root, file.path).replace(/\.md$/u, "").split(/[\\/]/u).join("-") ||
									basename(file.path)),
						sourcePath: file.path,
						sourceScope: scope,
						holding: source === "stepcode" ? "stepcode" : source === "plugin" ? "plugin" : "external",
						readiness: "ready",
						needsMigration: source !== "stepcode" && source !== "plugin",
						diagnostics: [],
					};
					const item = { dto, root: info(root)?.isFile() ? dirname(root) : root, base, mcp: file.mcp };
					try {
						this.inspect(item);
					} catch (error) {
						dto.readiness = "unsupported";
						dto.needsMigration = false;
						dto.diagnostics.push({ code: diagnosticCode(error) });
					}
					if (kind === "mcp" && source === "codex" && dto.needsMigration) {
						// Claude Code is read first and owns a shared server name; the Codex twin is shown, not offered.
						const claimed = records.some(
							(other) =>
								other.dto.kind === "mcp" && other.dto.source === "claude-code" && other.dto.name === dto.name,
						);
						if (claimed) {
							dto.needsMigration = false;
							dto.diagnostics.push({ code: "mcp-exists-in-claude-code" });
						}
					}
					records.push(item);
				}
				if (!report.diagnostics.length) report.status = files.length ? "ok" : "empty";
			} catch (error) {
				report.status = "error";
				report.diagnostics.push({ code: diagnosticCode(error) });
			}
		};
		const global: MigrationScope = { kind: "global" };
		for (const [source, root] of [
			["claude-code", this.paths.claude],
			["codex", this.paths.codex],
			["shared", join(this.paths.home, ".agents")],
			["stepcode", this.paths.agent],
			["stepcode", join(this.paths.home, this.paths.configDir)],
		] as const) {
			add("skills", source, global, join(root, "skills"));
		}
		if (this.paths.claude !== join(this.paths.home, ".claude"))
			add("skills", "claude-code", global, join(this.paths.home, ".claude", "skills"));
		add("mcp", "claude-code", global, this.paths.mcpSource("claude-code"));
		add("mcp", "codex", global, this.paths.mcpSource("codex"));
		for (const [source, root] of [
			["claude-code", this.paths.claude],
			["codex", this.paths.codex],
		] as const)
			for (const name of RULE_NAMES) add("rules", source, global, join(root, name));
		for (const cwd of this.paths.projects) {
			const scope: MigrationScope = { kind: "project", cwd };
			for (const [source, dir] of [
				["claude-code", ".claude"],
				["codex", ".codex"],
				["shared", ".agents"],
				["stepcode", this.paths.configDir],
			] as const) {
				add("skills", source, scope, join(cwd, dir, "skills"));
			}
			let ancestor = cwd;
			while (!info(join(ancestor, ".git")) && dirname(ancestor) !== ancestor) {
				ancestor = dirname(ancestor);
				if (ancestor !== this.paths.home) {
					add("skills", "shared", scope, join(ancestor, ".agents", "skills"));
					add("skills", "claude-code", scope, join(ancestor, ".claude", "skills"));
				}
			}
			for (const name of RULE_NAMES)
				add("rules", name.startsWith("CLAUDE") ? "claude-code" : "shared", scope, join(cwd, name));
			// Project declarations are deliberately not offered until their relative-path semantics are supported.
			if (kinds.includes("mcp"))
				result.sources.push({
					kind: "mcp",
					source: "claude-code",
					scope,
					path: join(cwd, ".mcp.json"),
					status: "unsupported",
					diagnostics: [{ code: "project-mcp-source-unsupported" }],
				});
		}
		if (kinds.includes("skills")) {
			try {
				for (const resource of installedPluginResources(this.paths))
					add(resource.kind, "plugin", resource.scope, resource.path, resource.pluginRoot);
			} catch (error) {
				for (const kind of ["skills"] as const)
					if (kinds.includes(kind))
						result.sources.push({
							kind,
							source: "plugin",
							scope: global,
							path: join(this.paths.home, this.paths.configDir, "plugins"),
							status: "error",
							diagnostics: [{ code: diagnosticCode(error) }],
						});
				for (const item of records)
					if (item.dto.kind === "skills") {
						item.dto.readiness = "unknown";
						item.dto.diagnostics.push({ code: "resource-inspection-incomplete" });
					}
			}
		}
		this.resolveSkillCollisions(records);
		result.candidates = records.map((item) => item.dto);
		return { result, records };
	}

	/** Destination reads never become source candidates or activate the resource loader. */
	destinationSkills(
		scope: MigrationScope,
		records: ResourceCandidate[],
		published: ReadonlySet<string> = new Set(),
	): {
		skills: { name: string; path: string; readiness: string }[];
		fingerprint: string;
		uncertain: boolean;
	} {
		const global: MigrationScope = { kind: "global" };
		const roots: { root: string; scope: MigrationScope }[] = [];
		const controls: unknown[] = [
			["trust", text(join(this.paths.agent, "trust.json"), true) ?? null],
			["global-config", text(this.paths.config, true) ?? null],
		];
		const add = (root: string, owner: MigrationScope): void => {
			if (!roots.some((entry) => entry.root === root)) roots.push({ root, scope: owner });
		};
		if (scope.kind === "project") {
			controls.push(["project-config", text(this.paths.configFor(scope), true) ?? null]);
			add(join(this.paths.resourceRoot(scope), "skills"), scope);
			for (const name of [".agents", ".claude"]) {
				let current = scope.cwd;
				let depth = 0;
				while (true) {
					if (++depth > 128) fail("resource-limit");
					if (current !== this.paths.home) add(join(current, name, "skills"), scope);
					const marker = join(current, ".git");
					safePath(marker);
					const entry = info(marker);
					controls.push([marker, entry ? [entry.dev, entry.ino, entry.isDirectory()] : null]);
					if (entry || dirname(current) === current) break;
					current = dirname(current);
				}
			}
		}
		for (const root of [
			this.paths.agent,
			join(this.paths.home, this.paths.configDir),
			join(this.paths.home, ".agents"),
			join(this.paths.home, ".claude"),
		])
			add(join(root, "skills"), global);
		const skills: { name: string; path: string; readiness: string }[] = [];
		let uncertain = false;
		let count = 0;
		let size = 0;
		const budget = { visited: 0 };
		const readSkill = (path: string): string => {
			const content = text(path)!;
			size += Buffer.byteLength(content);
			if (++count > 2000 || size > 32 * 1024 * 1024) fail("resource-limit");
			return content;
		};
		for (const entry of roots) {
			safePath(entry.root);
			const settings = settingsPatterns(this.paths, entry.scope);
			uncertain ||= settings.uncertain;
			controls.push([entry.root, resourceIgnoreFingerprint(entry.root, join(entry.root, "SKILL.md"))]);
			if (!info(entry.root)) continue;
			const trusted = entry.scope.kind === "global" || this.paths.trusted(entry.scope.cwd);
			for (const file of this.discover(entry.root, true, true, budget)) {
				if (published.has(file.path)) continue;
				const content = readSkill(file.path);
				controls.push([file.path, hash(content), resourceIgnoreFingerprint(entry.root, file.path)]);
				let name: string;
				try {
					name = skillMetadata(content, file.path).name;
				} catch {
					continue; // Invalid skills are not admitted by the default loader.
				}
				const readiness = !trusted
					? "untrusted"
					: skillIgnored(entry.root, file.path) || !enabled(file.path, settings.patterns, dirname(entry.root))
						? "disabled"
						: settings.uncertain
							? "unknown"
							: "ready";
				skills.push({ name, path: file.path, readiness });
			}
		}
		const plugins = destinationPluginResources(this.paths, scope);
		controls.push(["destination-plugins", plugins.fingerprint]);
		for (const resource of plugins.resources) {
			const entry = info(resource.path);
			controls.push([resource.path, entry ? "present" : "missing"]);
			if (!entry) continue;
			const root = entry.isDirectory() ? resource.path : dirname(resource.path);
			const snapshot = entry.isDirectory()
				? tree(resource.path)
				: [{ path: basename(resource.path), data: bytes(resource.path)! }];
			size += snapshot.reduce((bytes, file) => bytes + file.data.length, 0);
			count += snapshot.length;
			if (count > 2000 || size > 32 * 1024 * 1024) fail("resource-limit");
			controls.push([resource.path, treeHash(snapshot)]);
			if (resource.kind !== "skills") continue;
			const settings = settingsPatterns(this.paths, resource.scope);
			uncertain ||= settings.uncertain;
			const trusted = resource.scope.kind === "global" || this.paths.trusted(resource.scope.cwd);
			const files = entry.isDirectory()
				? this.discover(resource.path, true, true, budget)
				: [{ path: resource.path }];
			for (const file of files) {
				controls.push([file.path, resourceIgnoreFingerprint(root, file.path)]);
				if (published.has(file.path) || skills.some((skill) => skill.path === file.path)) continue;
				let name: string;
				try {
					name = skillMetadata(readSkill(file.path), file.path).name;
				} catch (error) {
					if (diagnosticCode(error) !== "invalid-skill") throw error;
					continue; // Invalid skills are not admitted by the default loader.
				}
				const readiness = !trusted
					? "untrusted"
					: skillIgnored(root, file.path) || !enabled(file.path, settings.patterns, resource.pluginRoot)
						? "disabled"
						: settings.uncertain
							? "unknown"
							: "ready";
				skills.push({ name, path: file.path, readiness });
			}
		}
		// Previously inspected non-plugin resources remain evidence, not destination source discovery.
		for (const { dto } of records) {
			if (
				dto.source === "plugin" ||
				dto.kind !== "skills" ||
				dto.holding === "external" ||
				published.has(dto.sourcePath) ||
				(dto.sourceScope.kind === "project" && (scope.kind !== "project" || dto.sourceScope.cwd !== scope.cwd)) ||
				skills.some((skill) => skill.path === dto.sourcePath)
			)
				continue;
			controls.push([
				dto.sourcePath,
				hash(readSkill(dto.sourcePath)),
				resourceIgnoreFingerprint(dirname(dto.sourcePath), dto.sourcePath),
			]);
			uncertain ||= dto.readiness === "unknown";
			skills.push({ name: dto.name, path: dto.sourcePath, readiness: dto.readiness });
		}
		return { skills, uncertain, fingerprint: hash(stable({ controls, skills })) };
	}

	/**
	 * Default MCP sources the CLI import review (`[mcp_import] reviewed` in config.toml) already handled.
	 * An explicitly chosen source file is always scanned: the user asked for that file.
	 */
	private cliReviewedMcpSources(): Set<MigrationSource> {
		let reviewed: string[];
		try {
			// Scan stays read-only: parse the file directly instead of the CLI store, which may create directories.
			reviewed = readStepMcpImportReviewedSources(configDocument(this.paths.configFor({ kind: "global" })));
		} catch {
			// A malformed config.toml is reported by MCP inspection itself; offering every source is the safe default.
			reviewed = [];
		}
		const sources = new Set<MigrationSource>();
		if (reviewed.includes(".claude") && !this.paths.customMcpSource("claude-code")) sources.add("claude-code");
		if (reviewed.includes(".codex") && !this.paths.customMcpSource("codex")) sources.add("codex");
		return sources;
	}

	private discover(
		root: string,
		skills: boolean,
		recursivePrompts = true,
		budget = { visited: 0 },
	): { path: string }[] {
		const found: { path: string }[] = [];
		const walk = (dir: string, depth: number): void => {
			if (depth > 12 || ++budget.visited > 2000) fail("resource-limit");
			safePath(dir);
			if (skills && info(join(dir, "SKILL.md"))) {
				found.push({ path: join(dir, "SKILL.md") });
				return;
			}
			const entries = readdirSync(dir, { withFileTypes: true });
			if (entries.length > 2000) fail("resource-limit");
			for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
				if (entry.isSymbolicLink()) fail("unsafe-link");
				if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
				const path = join(dir, entry.name);
				if (entry.isDirectory() && (skills || recursivePrompts)) walk(path, depth + 1);
				else if (entry.isFile() && entry.name.endsWith(".md") && (!skills || depth === 0)) found.push({ path });
			}
		};
		walk(root, 0);
		return found;
	}

	private inspect(item: ResourceCandidate): void {
		const dto = item.dto;
		if (dto.source === "plugin" && dto.sourceScope.kind === "project" && !this.paths.trusted(dto.sourceScope.cwd))
			dto.readiness = "untrusted";
		if (dto.kind === "mcp") {
			if (item.mcp) {
				dto.diagnostics.push(...item.mcp.translated.diagnostics);
				dto.mcpTransport = item.mcp.translated.transport;
			}
			if (!item.mcp?.config) fail("unsupported-mcp-config");
			const config = item.mcp.config;
			const servers = targetServers(this.paths);
			const match = Object.entries(servers).find(([, target]) => mcpIdentity(target) === mcpIdentity(config));
			if (match) {
				dto.holding = "stepcode";
				dto.needsMigration = false;
				dto.readiness = record(match[1]).enabled === false ? "disabled" : "ready";
				dto.diagnostics.push({ code: "mcp-configured-equal", path: this.paths.configFor({ kind: "global" }) });
			} else if (Object.hasOwn(servers, dto.name)) {
				// Same name, different declaration: StepCode's own entry wins, matching the CLI import review,
				// which never offers to overwrite or rename around a server the user already configured.
				dto.holding = "stepcode";
				dto.needsMigration = false;
				dto.diagnostics.push({ code: "mcp-exists-in-stepcode", path: this.paths.configFor({ kind: "global" }) });
			} else {
				const plugins = pluginMcpMatches(this.paths, config);
				if (plugins.length) {
					dto.holding = "plugin";
					dto.needsMigration = false;
					dto.readiness = plugins.some((p) => p.enabled) ? "ready" : "disabled";
					dto.diagnostics.push({ code: "plugin-provided", path: plugins[0]!.path });
				}
			}
			if (sanitizedMcp(config).stripped) dto.diagnostics.push({ code: "sensitive-values-omitted" });
			return;
		}
		const content = text(dto.sourcePath)!;
		if (dto.kind === "rules") {
			dto.targetPath = join(dto.sourceScope.kind === "global" ? this.paths.agent : dto.sourceScope.cwd, "AGENTS.md");
			const migrated = text(dto.targetPath, true);
			// The destination already carries this source's text (an earlier migration); do not offer it again.
			if (content.trim() && migrated?.includes(content.trim()) && dto.targetPath !== dto.sourcePath) {
				dto.needsMigration = false;
				dto.diagnostics.push({ code: "rules-already-migrated", path: dto.targetPath });
				return;
			}
			if (isDirectRule(this.paths, dto.sourcePath, dto.sourceScope)) {
				dto.holding = "reference";
				dto.needsMigration = false;
				dto.diagnostics.push({ code: "direct-reference" });
			}
			return;
		}
		const metadata = skillMetadata(content, dto.sourcePath);
		dto.name = metadata.name;
		const settings = settingsPatterns(this.paths, dto.sourceScope);
		const shared =
			dto.source === "shared" ||
			dto.source === "stepcode" ||
			(dto.source === "claude-code" &&
				(dto.sourceScope.kind === "project" || item.root === join(this.paths.home, ".claude", "skills")));
		const ignoredScope = skillIgnored(item.root, dto.sourcePath);
		if (ignoredScope || !enabled(dto.sourcePath, settings.patterns, item.base)) {
			dto.readiness = "disabled";
			dto.needsMigration = false;
		} else if (dto.sourceScope.kind === "project" && !this.paths.trusted(dto.sourceScope.cwd)) {
			dto.readiness = "untrusted";
			dto.needsMigration = false;
		} else if (settings.uncertain) {
			dto.readiness = "unknown";
			dto.needsMigration = false;
			dto.diagnostics.push({ code: "resource-inspection-incomplete" });
		} else if (shared) {
			dto.holding = dto.source === "stepcode" ? "stepcode" : "reference";
			dto.needsMigration = false;
			dto.diagnostics.push({ code: "direct-reference" });
		}
		if (metadata.frontmatter["disable-model-invocation"] === true)
			dto.diagnostics.push({ code: "skill-manual-invocation-only" });
	}

	private resolveSkillCollisions(records: ResourceCandidate[]): void {
		const skills = records.filter(
			(item) => item.dto.kind === "skills" && item.dto.readiness === "ready" && item.dto.holding !== "external",
		);
		const rank = (item: ResourceCandidate): number =>
			item.dto.source === "plugin"
				? item.dto.sourceScope.kind === "project"
					? 20
					: 21
				: (item.dto.sourceScope.kind === "project" ? 0 : 10) +
					(item.dto.source === "stepcode" ? 0 : item.dto.source === "shared" ? 1 : 2);
		const winners = new Map<string, ResourceCandidate>();
		for (const item of skills.sort((a, b) => rank(a) - rank(b))) {
			const key = `${item.dto.sourceScope.kind === "project" ? item.dto.sourceScope.cwd : "global"}\0${item.dto.name}`;
			const previous =
				winners.get(key) ?? (item.dto.source === "plugin" ? winners.get(`global\0${item.dto.name}`) : undefined);
			if (previous && previous.dto.sourcePath !== item.dto.sourcePath) {
				item.dto.readiness = "shadowed";
				item.dto.diagnostics.push({ code: "skill-name-shadowed", path: previous.dto.sourcePath });
			} else winners.set(key, item);
		}
		for (const item of skills) {
			if (item.dto.sourceScope.kind !== "global" || item.dto.readiness !== "ready") continue;
			const shadowing = [...this.paths.projects]
				.map((cwd) => winners.get(`${cwd}\0${item.dto.name}`))
				.filter((winner) => winner && (winner.dto.source !== "plugin" || item.dto.source === "plugin"));
			if (!shadowing.length) continue;
			item.dto.readiness = shadowing.length === this.paths.projects.size ? "shadowed" : "unknown";
			item.dto.diagnostics.push({ code: "skill-name-shadowed", path: shadowing[0]!.dto.sourcePath });
		}
	}
}

export function resourceSnapshot(
	item: ResourceCandidate,
	copyPackage = true,
): { files: PackageFile[]; fingerprint: string; sourceText: string } {
	if (item.dto.kind === "skills" && copyPackage) {
		if (basename(item.dto.sourcePath) !== "SKILL.md") fail("standalone-skill-copy-unsupported");
		const files = tree(dirname(item.dto.sourcePath));
		return { files, fingerprint: treeHash(files), sourceText: text(item.dto.sourcePath)! };
	}
	const sourceText = text(item.dto.sourcePath)!;
	return { files: [], fingerprint: hash(sourceText), sourceText };
}

function skillIgnored(root: string, path: string): boolean {
	const directories = [root];
	let current = root;
	for (const part of relative(root, dirname(path)).split(/[\\/]/u).filter(Boolean)) {
		current = join(current, part);
		directories.push(current);
	}
	let matcher: SkillIgnoreMatcher | undefined;
	for (const directory of directories) {
		const rel = relative(root, directory).replaceAll("\\", "/");
		if (rel && matcher?.ignores(`${rel}/`)) return true;
		const next = new SkillIgnoreMatcher(rel, matcher);
		for (const name of [".gitignore", ".ignore", ".fdignore"]) {
			const rules = text(join(directory, name), true);
			if (rules !== undefined) next.add(rules);
		}
		matcher = next;
	}
	return matcher?.ignores(relative(root, path).replaceAll("\\", "/")) ?? false;
}
