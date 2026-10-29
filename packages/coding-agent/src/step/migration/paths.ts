import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { resolveStepConfigDir, resolveStepHomeDir } from "../environment.ts";
import { anchor, fail, info, inside, record, safePath, text } from "./filesystem.ts";
import type { MigrationScope } from "./types.ts";

export class MigrationPaths {
	readonly agent: string;
	readonly home: string;
	readonly env: NodeJS.ProcessEnv;
	readonly configDir: string;
	readonly config: string;
	readonly claude: string;
	readonly codex: string;
	readonly projects = new Set<string>();
	private readonly projectIdentities = new Map<string, string>();
	private readonly targetIdentities = new Map<string, string>();
	private readonly inputHome: string;
	constructor(agentDir: string, env: NodeJS.ProcessEnv) {
		this.inputHome = resolveStepHomeDir(env);
		this.home = anchor(this.inputHome);
		this.agent = this.inputPath(agentDir);
		this.configDir = resolveStepConfigDir(env);
		if (basename(this.configDir) !== this.configDir || [".", ".."].includes(this.configDir))
			fail("invalid-config-namespace");
		// Anchor every path this object hands out: on macOS /var and /tmp are symlinks, and a
		// raw value would make safePath() reject StepCode's own plugin directory as an unsafe link.
		this.env = { ...env, HOME: this.home, STEP_CODING_AGENT_DIR: this.agent };
		if (env.STEPCODE_STORAGE_ROOT_DIR?.trim()) {
			// Resolve symlinks first: a storage root reached through one is still the same directory.
			const requested = resolve(env.STEPCODE_STORAGE_ROOT_DIR.trim());
			this.env.STEPCODE_STORAGE_ROOT_DIR = this.inputPath(
				existsSync(requested) ? realpathSync(requested) : requested,
			);
		}
		this.config = join(dirname(this.agent), "config.toml");
		this.claude = this.sourceRoot(env.CLAUDE_CONFIG_DIR, ".claude");
		this.codex = this.sourceRoot(env.CODEX_HOME, ".codex");
	}
	private mcpSourcePaths: Partial<Record<"claude-code" | "codex", string>> = {};
	chooseMcpSources(value: unknown): void {
		if (value === undefined) {
			this.mcpSourcePaths = {};
			return;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-mcp-sources");
		const next: Partial<Record<"claude-code" | "codex", string>> = {};
		for (const [source, path] of Object.entries(value)) {
			if (source !== "claude-code" && source !== "codex") fail("invalid-mcp-sources");
			if (typeof path !== "string" || path.length > 4096) fail("invalid-mcp-sources");
			next[source] = this.inputPath(path);
		}
		this.mcpSourcePaths = next;
	}
	mcpSource(source: "claude-code" | "codex"): string {
		return (
			this.mcpSourcePaths[source] ??
			(source === "codex" ? join(this.codex, "config.toml") : join(this.home, ".claude.json"))
		);
	}
	private sourceRoot(value: string | undefined, fallback: string): string {
		return this.inputPath(value?.trim() || join(this.home, fallback));
	}
	private inputPath(path: string): string {
		if (typeof path !== "string" || !isAbsolute(path)) fail("invalid-path");
		let normalized = inside(resolve(this.inputHome), resolve(path))
			? join(this.home, relative(resolve(this.inputHome), resolve(path)))
			: resolve(path);
		// macOS exposes these system-owned aliases; resource-level links remain forbidden.
		if (process.platform === "darwin")
			for (const alias of ["/var", "/tmp"]) {
				if (inside(alias, normalized)) normalized = join(anchor(alias), relative(alias, normalized));
			}
		safePath(normalized);
		return normalized;
	}
	chooseProjects(values: unknown): void {
		if (values === undefined) return;
		if (!Array.isArray(values) || values.length > 30) fail("invalid-projects");
		const selected = new Set<string>();
		for (const value of values) {
			if (typeof value !== "string" || !isAbsolute(value)) fail("invalid-projects");
			const path = this.inputPath(value);
			if (!info(path)?.isDirectory()) fail("invalid-projects");
			selected.add(path);
		}
		this.projects.clear();
		this.projectIdentities.clear();
		for (const path of selected) {
			this.projects.add(path);
			this.projectIdentities.set(path, this.existingProjectIdentity(path));
		}
	}
	private existingProjectIdentity(cwd: string): string {
		try {
			safePath(cwd);
			const directory = info(cwd);
			if (!directory?.isDirectory() || directory.isSymbolicLink() || anchor(cwd) !== cwd) fail("invalid-projects");
			return `${directory.dev}:${directory.ino}:${directory.birthtimeMs}`;
		} catch {
			return fail("invalid-projects");
		}
	}
	/** Explicit destinations authorize writes only; never add them to the source-scan project set. */
	chooseTarget(value: unknown): void {
		if (value === undefined) return;
		const input = record(value);
		if (input.kind === "global") {
			if (input.create !== undefined) fail("invalid-scope");
			return;
		}
		if (input.kind !== "project" || typeof input.cwd !== "string") fail("invalid-scope");
		if (input.create !== undefined && input.create !== true) fail("invalid-scope");
		const cwd = this.inputPath(input.cwd);
		// `create` is the user's explicit request for a workspace folder that does not exist yet;
		// it is the single preview-time write, bounded to one level under an existing directory.
		if (input.create === true) this.ensureTargetDirectory(cwd);
		const identity = this.existingProjectIdentity(cwd);
		const known = this.projectIdentities.get(cwd) ?? this.targetIdentities.get(cwd);
		if (known && known !== identity) fail("invalid-projects");
		this.targetIdentities.set(cwd, identity);
	}
	private ensureTargetDirectory(cwd: string): void {
		if (info(cwd)?.isDirectory()) return; // Explicit creation is idempotent when the folder already exists.
		// Recreate the missing tail of the path under its nearest existing ancestor, so an
		// inherited original workspace can always be restored; never widen beyond a few levels.
		const missing: string[] = [];
		let current = cwd;
		while (!info(current)) {
			missing.unshift(current);
			const parent = dirname(current);
			if (parent === current || missing.length > 5) fail("invalid-projects");
			current = parent;
		}
		const ancestor = info(current);
		if (!ancestor?.isDirectory() || ancestor.isSymbolicLink()) fail("invalid-projects");
		safePath(current);
		for (const path of missing) {
			const name = basename(path);
			if (!name || name.length > 60) fail("invalid-projects");
			try {
				mkdirSync(path, { mode: 0o755 });
			} catch {
				fail("invalid-projects");
			}
		}
	}
	projectIdentity(scope: MigrationScope): string | undefined {
		if (scope.kind === "global") return undefined;
		const expected = this.projectIdentities.get(scope.cwd) ?? this.targetIdentities.get(scope.cwd);
		if (!expected) fail("project-not-selected");
		const identity = this.existingProjectIdentity(scope.cwd);
		if (identity !== expected) fail("invalid-projects");
		return identity;
	}
	scope(value: unknown, fallback: MigrationScope = { kind: "global" }): MigrationScope {
		const input = record(value === undefined ? fallback : value);
		if (input.kind === "global") return { kind: "global" };
		if (input.kind !== "project" || typeof input.cwd !== "string") fail("invalid-scope");
		const cwd = this.inputPath(input.cwd);
		const scope: MigrationScope = { kind: "project", cwd };
		this.projectIdentity(scope);
		return scope;
	}
	/** Durable intent permits explicit recovery, without registering a source or repinning a replacement. */
	validateRecordedProject(scope: MigrationScope, expected?: string): void {
		if (scope.kind === "global") return;
		if (this.inputPath(scope.cwd) !== scope.cwd) fail("invalid-projects");
		const known = this.projectIdentities.get(scope.cwd) ?? this.targetIdentities.get(scope.cwd);
		if (expected === undefined) expected = known;
		if (!expected) fail("project-not-selected");
		const actual = this.existingProjectIdentity(scope.cwd);
		if (actual !== expected || (known !== undefined && known !== actual)) fail("invalid-projects");
	}
	resourceRoot(scope: MigrationScope): string {
		return scope.kind === "global" ? this.agent : join(scope.cwd, this.configDir);
	}
	configFor(scope: MigrationScope): string {
		return scope.kind === "global" ? this.config : join(this.resourceRoot(scope), "config.toml");
	}
	trusted(cwd: string): boolean {
		const raw = text(join(this.agent, "trust.json"), true);
		if (raw === undefined) return false;
		let data: Record<string, unknown>;
		try {
			data = record(JSON.parse(raw));
		} catch {
			return fail("invalid-trust-store");
		}
		if (Object.values(data).some((v) => v !== true && v !== false && v !== null)) fail("invalid-trust-store");
		let current = cwd;
		while (true) {
			if (typeof data[current] === "boolean") return data[current] === true;
			if (dirname(current) === current) return false;
			current = dirname(current);
		}
	}
}

export function configDocument(path: string): Record<string, unknown> {
	const raw = text(path, true);
	if (raw === undefined) return {};
	try {
		return record(parseToml(raw));
	} catch {
		return fail("invalid-target-config");
	}
}
export function resourceName(value: unknown, skill = false): string {
	if (
		typeof value !== "string" ||
		value.length > 64 ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(value) ||
		["__proto__", "constructor", "prototype"].includes(value)
	)
		fail("invalid-resource-name");
	if (skill && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) fail("invalid-skill-name");
	return value;
}
