import { isMap, isScalar, parse, parseDocument } from "yaml";
import { SkillIgnoreMatcher } from "./skill-discovery.ts";
import { type ExecutionEnv, type FileInfo, type Result, type Skill, toError } from "./types.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export type SkillDiagnosticCode =
	| "file_info_failed"
	| "list_failed"
	| "read_failed"
	| "parse_failed"
	| "invalid_metadata";

/** Warning produced while loading skills. */
export interface SkillDiagnostic {
	/** Diagnostic severity. Currently only warnings are emitted. */
	type: "warning";
	/** Stable diagnostic code. */
	code: SkillDiagnosticCode;
	/** Human-readable diagnostic message. */
	message: string;
	/** Path associated with the diagnostic. */
	path: string;
}

interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

/** Format a skill invocation prompt, optionally appending additional user instructions. */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
	const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirnameEnvPath(skill.filePath)}.\n\n${skill.content}\n</skill>`;
	return additionalInstructions ? `${skillBlock}\n\n${additionalInstructions}` : skillBlock;
}

/**
 * Load skills from one or more directories.
 *
 * Traverses directories recursively, loads `SKILL.md` files, loads direct root `.md` files with skill
 * frontmatter, honors ignore files, and returns diagnostics for invalid declared skill files. Missing input
 * directories are skipped.
 */
export async function loadSkills(
	env: ExecutionEnv,
	dirs: string | string[],
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
		const rootInfoResult = await env.fileInfo(dir);
		if (!rootInfoResult.ok) {
			if (rootInfoResult.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: rootInfoResult.error.message,
					path: dir,
				});
			}
			continue;
		}
		const rootInfo = rootInfoResult.value;
		if ((await resolveKind(env, rootInfo, diagnostics)) !== "directory") continue;
		const result = await loadSkillsFromDirInternal(env, rootInfo.path, true, undefined, rootInfo.path, new Set());
		skills.push(...result.skills);
		diagnostics.push(...result.diagnostics);
	}
	return { skills, diagnostics };
}

/**
 * Load skills from source-tagged directories.
 *
 * Source values are preserved exactly and attached to every loaded skill and diagnostic. The agent package does not
 * interpret source values; applications define their own provenance shape.
 */
export async function loadSourcedSkills<TSource, TSkill extends Skill = Skill>(
	env: ExecutionEnv,
	inputs: Array<{ path: string; source: TSource }>,
	mapSkill?: (skill: Skill, source: TSource) => TSkill,
): Promise<{
	skills: Array<{ skill: TSkill; source: TSource }>;
	diagnostics: Array<SkillDiagnostic & { source: TSource }>;
}> {
	const skills: Array<{ skill: TSkill; source: TSource }> = [];
	const diagnostics: Array<SkillDiagnostic & { source: TSource }> = [];
	for (const input of inputs) {
		const result = await loadSkills(env, input.path);
		for (const skill of result.skills) {
			skills.push({ skill: mapSkill ? mapSkill(skill, input.source) : (skill as TSkill), source: input.source });
		}
		for (const diagnostic of result.diagnostics) diagnostics.push({ ...diagnostic, source: input.source });
	}
	return { skills, diagnostics };
}

async function loadSkillsFromDirInternal(
	env: ExecutionEnv,
	dir: string,
	includeRootFiles: boolean,
	parentIgnoreMatcher: SkillIgnoreMatcher | undefined,
	rootDir: string,
	visitedDirs: Set<string>,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];

	const dirInfoResult = await env.fileInfo(dir);
	if (!dirInfoResult.ok) {
		if (dirInfoResult.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: dirInfoResult.error.message,
				path: dir,
			});
		}
		return { skills, diagnostics };
	}
	const dirInfo = dirInfoResult.value;
	if ((await resolveKind(env, dirInfo, diagnostics)) !== "directory") return { skills, diagnostics };

	const canonicalDir = await env.canonicalPath(dir);
	const realDir = canonicalDir.ok ? canonicalDir.value : dirInfo.path;
	if (visitedDirs.has(realDir)) return { skills, diagnostics };
	visitedDirs.add(realDir);

	const ignoreMatcher = new SkillIgnoreMatcher(relativeEnvPath(rootDir, dir), parentIgnoreMatcher);
	await addIgnoreRules(env, ignoreMatcher, dir, diagnostics);

	const entriesResult = await env.listDir(dir);
	if (!entriesResult.ok) {
		diagnostics.push({ type: "warning", code: "list_failed", message: entriesResult.error.message, path: dir });
		return { skills, diagnostics };
	}
	const entries = entriesResult.value;

	for (const entry of entries) {
		if (entry.name !== "SKILL.md") continue;
		const fullPath = entry.path;
		const kind = await resolveKind(env, entry, diagnostics);
		if (kind !== "file") continue;
		const relPath = relativeEnvPath(rootDir, fullPath);
		if (ignoreMatcher.ignores(relPath)) continue;

		const result = await loadSkillFromFile(env, fullPath, dirInfo.name);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
		return { skills, diagnostics };
	}

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = entry.path;
		const kind = await resolveKind(env, entry, diagnostics);
		if (!kind) continue;

		const relPath = relativeEnvPath(rootDir, fullPath);
		const ignorePath = kind === "directory" ? `${relPath}/` : relPath;
		if (ignoreMatcher.ignores(ignorePath)) continue;

		if (kind === "directory") {
			const result = await loadSkillsFromDirInternal(env, fullPath, false, ignoreMatcher, rootDir, visitedDirs);
			skills.push(...result.skills);
			diagnostics.push(...result.diagnostics);
			continue;
		}

		if (kind !== "file" || !includeRootFiles || !entry.name.endsWith(".md")) continue;
		const result = await loadSkillFromFile(env, fullPath, dirInfo.name);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
	}

	return { skills, diagnostics };
}

async function addIgnoreRules(
	env: ExecutionEnv,
	ig: SkillIgnoreMatcher,
	dir: string,
	diagnostics: SkillDiagnostic[],
): Promise<void> {
	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePathResult = await env.joinPath([dir, filename]);
		if (!ignorePathResult.ok) {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: ignorePathResult.error.message,
				path: dir,
			});
			continue;
		}
		const ignorePath = ignorePathResult.value;
		const info = await env.fileInfo(ignorePath);
		if (!info.ok) {
			if (info.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: info.error.message,
					path: ignorePath,
				});
			}
			continue;
		}
		if (info.value.kind !== "file") continue;
		const content = await env.readTextFile(ignorePath);
		if (!content.ok) {
			diagnostics.push({ type: "warning", code: "read_failed", message: content.error.message, path: ignorePath });
			continue;
		}
		ig.add(content.value);
	}
}

async function loadSkillFromFile(
	env: ExecutionEnv,
	filePath: string,
	parentDirName: string,
): Promise<{ skill: Skill | null; diagnostics: SkillDiagnostic[] }> {
	const diagnostics: SkillDiagnostic[] = [];
	const isDeclaredSkill =
		filePath
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.pop() === "SKILL.md";
	const rawContent = await env.readTextFile(filePath);
	if (!rawContent.ok) {
		diagnostics.push({ type: "warning", code: "read_failed", message: rawContent.error.message, path: filePath });
		return { skill: null, diagnostics };
	}

	const parsed = parseFrontmatter<SkillFrontmatter>(rawContent.value);
	if (!parsed.ok) {
		if (isDeclaredSkill) {
			diagnostics.push({
				type: "warning",
				code: "parse_failed",
				message: formatFrontmatterError(filePath, parsed.error, rawContent.value),
				path: filePath,
			});
		}
		return { skill: null, diagnostics };
	}

	const { frontmatter, body } = parsed.value;
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;
	if (!isDeclaredSkill && (!description || description.trim() === "")) {
		return { skill: null, diagnostics };
	}

	for (const error of validateDescription(description, filePath)) {
		diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
	}

	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName || parentDirName;
	for (const error of validateName(name, parentDirName)) {
		diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
	}

	if (!description || description.trim() === "") {
		return { skill: null, diagnostics };
	}

	return {
		skill: {
			name,
			description,
			content: body,
			filePath,
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		},
		diagnostics,
	};
}

function validateName(name: string, parentDirName: string): string[] {
	const errors: string[] = [];
	if (name !== parentDirName) errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	}
	if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
	if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
	return errors;
}

/**
 * Validate description per Agent Skills spec.
 *
 * `filePath` keeps the "missing description" diagnostic self-contained so it stays actionable
 * wherever diagnostics are surfaced.
 */
function validateDescription(description: string | undefined, filePath: string): string[] {
	const errors: string[] = [];
	if (!description || description.trim() === "") {
		errors.push(`${filePath}: frontmatter is missing "description" — add e.g. description: "..."`);
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}
	return errors;
}

function extractFrontmatterBlock(content: string): { yamlString: string | null; body: string } {
	const normalized = content
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return { yamlString: null, body: normalized };
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { yamlString: null, body: normalized };
	return { yamlString: normalized.slice(4, endIndex), body: normalized.slice(endIndex + 4).trim() };
}

function parseFrontmatter<T extends Record<string, unknown>>(
	content: string,
): Result<{ frontmatter: T; body: string }, Error> {
	try {
		const { yamlString, body } = extractFrontmatterBlock(content);
		if (yamlString === null) return { ok: true, value: { frontmatter: {} as T, body } };
		return { ok: true, value: { frontmatter: (parse(yamlString) ?? {}) as T, body } };
	} catch (error) {
		return { ok: false, error: toError(error) };
	}
}

/**
 * The YAML block always starts on file line 2 (right after the opening `---`), so parser line
 * numbers are shifted to point at the line a user actually edits.
 */
const YAML_TO_FILE_LINE_OFFSET = 1;

/**
 * Flatten a `yaml` parse error into a single line.
 *
 * The `yaml` package appends a quoted (and possibly truncated) source line plus a caret to its
 * messages, which wraps into an unreadable block inside the diagnostics list.
 */
function describeFrontmatterError(error: unknown): { line?: number; column?: number; reason: string } {
	const message = error instanceof Error ? error.message : String(error);
	const headline = (message.split("\n")[0] ?? "").replace(
		/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	const location = /^(.*?)\s+at line (\d+), column (\d+)/.exec(headline ?? "");
	const position = (error as { linePos?: Array<{ line?: number; col?: number }> })?.linePos?.[0];
	const line = position?.line ?? (location ? Number(location[2]) : undefined);
	const column = position?.col ?? (location ? Number(location[3]) : undefined);
	const reason = (location?.[1] ?? headline ?? "").trim() || "invalid YAML";

	return {
		line: line === undefined ? undefined : line + YAML_TO_FILE_LINE_OFFSET,
		column,
		reason,
	};
}

/** Detect a rejected compact mapping in the top-level description value. */
function hasUnquotedColonInDescription(content: string): boolean {
	const { yamlString } = extractFrontmatterBlock(content);
	if (!yamlString) return false;

	// Inspect the parser's recovered tree so comments, quoted strings and block scalar
	// contents cannot be mistaken for description keys.
	const document = parseDocument(yamlString);
	if (!isMap(document.contents)) return false;
	return document.contents.items.some(({ key, value }) => {
		if (!isScalar(key) || key.value !== "description" || !isMap(value)) return false;
		const start = value.range?.[0];
		const keyEnd = key.range?.[1];
		if (start === undefined || keyEnd === undefined) return false;
		// A normal nested mapping on the next line is not an unquoted description.
		if (yamlString.slice(keyEnd, start).includes("\n")) return false;
		return document.errors.some((error) => error.code === "BLOCK_AS_IMPLICIT_KEY" && error.pos[0] === start);
	});
}

/**
 * Build a single-line, actionable diagnostic for a frontmatter syntax error, e.g.
 * `/path/SKILL.md: invalid YAML frontmatter at line 3, column 14: Nested mappings are not allowed
 * in compact mappings — description contains an unquoted ":" — wrap the value in double quotes`.
 */
function formatFrontmatterError(filePath: string, error: unknown, content: string): string {
	const { line, column, reason } = describeFrontmatterError(error);
	const at =
		line !== undefined && column !== undefined
			? ` at line ${line}, column ${column}`
			: line !== undefined
				? ` at line ${line}`
				: "";
	const hint = hasUnquotedColonInDescription(content)
		? ' — description contains an unquoted ":" — wrap the value in double quotes'
		: "";

	return `${filePath}: invalid YAML frontmatter${at}: ${reason}${hint}`;
}

async function resolveKind(
	env: ExecutionEnv,
	info: FileInfo,
	diagnostics: SkillDiagnostic[],
): Promise<"file" | "directory" | undefined> {
	if (info.kind === "file" || info.kind === "directory") return info.kind;
	const canonicalPath = await env.canonicalPath(info.path);
	if (!canonicalPath.ok) {
		if (canonicalPath.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: canonicalPath.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	const target = await env.fileInfo(canonicalPath.value);
	if (!target.ok) {
		if (target.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: target.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : undefined;
}

function dirnameEnvPath(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (separatorIndex === 2 && normalized[1] === ":") return normalized.slice(0, 3);
	return separatorIndex <= 0 ? "/" : normalized.slice(0, separatorIndex);
}

function relativeEnvPath(root: string, path: string): string {
	const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
	const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
	if (normalizedPath === normalizedRoot) return "";
	return normalizedPath.startsWith(`${normalizedRoot}/`)
		? normalizedPath.slice(normalizedRoot.length + 1)
		: normalizedPath.replace(/^\/+/, "");
}
