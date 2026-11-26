/**
 * Validate the configuration files a build reads against the schema it ships.
 *
 * The runtime never refuses to start over a setting: an unrecognized value
 * falls back to its default with a warning, and an unknown key is carried along
 * and ignored. That is the right behavior for a running session, but it is also
 * why "I configured it and nothing changed" is hard to notice. `step config
 * check` answers the question a running session cannot: is every key and value
 * in this file actually used?
 *
 * Any rejection is reported and fails the check, because a rejected key or
 * value does not do what it says. A file that cannot be parsed is reported
 * instead, and the rest of that file is skipped.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Settings as TypeBoxSettings } from "typebox/system";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";
import { ConfigTomlSchema, renderStrictModelsSchema } from "./config-schema.ts";
import { configSchemaDirective } from "./schema-files.ts";
import { STEPCODE_VERSION } from "./version.ts";

type Validator = {
	Check: (value: unknown) => boolean;
	Errors: (value: unknown) => TLocalizedValidationError[];
};

type JsonNode = {
	readonly type?: string;
	readonly anyOf?: readonly JsonNode[];
	readonly oneOf?: readonly JsonNode[];
	readonly const?: unknown;
	readonly enum?: readonly unknown[];
	readonly properties?: Record<string, JsonNode>;
	readonly patternProperties?: Record<string, JsonNode>;
	readonly items?: JsonNode;
	readonly additionalProperties?: boolean | JsonNode;
};

const validateConfig: Validator = Compile(ConfigTomlSchema);
// The editor schema, not the loader's: an unknown field in models.json is never
// read, and `check` exists to say so.
const modelsSchemaJson = JSON.parse(renderStrictModelsSchema()) as object;
const validateModels: Validator = Compile(modelsSchemaJson);

export interface ConfigProblem {
	/** File the problem was found in, as reported to the user. */
	readonly file: string;
	/**
	 * JSON Pointer into the document. Keys are escaped, so a key that itself
	 * contains `/` or a dot stays unambiguous
	 * (`/compaction/modelTriggerRatios/vendor~1model.3`).
	 */
	readonly path: string;
	readonly message: string;
	/**
	 * `unknown` means this build does not read the key; `invalid` means it reads it
	 * and rejects the value. A reader can filter on this without parsing messages.
	 */
	readonly kind: "unknown" | "invalid" | "parse";
}

export interface ConfigCheckResult {
	readonly problems: readonly ConfigProblem[];
	/** Files that were read; a missing optional file is not a problem. */
	readonly checkedFiles: readonly string[];
	/**
	 * Context a reader needs to interpret the problems, such as a project file
	 * that the runtime only loads when the project is trusted.
	 */
	readonly notes: readonly string[];
}

const escapePointer = (segment: string) => segment.replace(/~/g, "~0").replace(/\//g, "~1");
const unescapePointer = (segment: string) => segment.replace(/~1/g, "/").replace(/~0/g, "~");

/** Human-readable form of a pointer, for the one-line output. */
export function describePath(path: string): string {
	const segments = path.split("/").filter((segment) => segment.length > 0);
	return segments
		.map((segment) => {
			const key = unescapePointer(segment);
			// A key that contains a dot is shown bracketed so it cannot be mistaken
			// for two levels.
			return key.includes(".") ? `["${key}"]` : key;
		})
		.join(".")
		.replace(/\.\["/g, '["');
}

/** Whether a node accepts one of several shapes. */
function unionMembers(node: JsonNode): readonly JsonNode[] | undefined {
	return node.anyOf ?? node.oneOf;
}

/** The object-shaped members of a union, or the node itself when it is one. */
function objectShapes(node: JsonNode): JsonNode[] {
	const members = unionMembers(node);
	if (!members) return node.properties || node.patternProperties ? [node] : [];
	return members.flatMap(objectShapes);
}

/** Schema node at a pointer, preferring a concrete property over a wildcard. */
function nodeAt(schema: JsonNode, segments: readonly string[]): JsonNode | undefined {
	let node: JsonNode | undefined = schema;
	for (const segment of segments) {
		if (!node) return undefined;
		if (node.items) {
			// A pointer inside an array carries the index; `items` describes every
			// element, so descend without consuming the index segment.
			node = node.items;
			continue;
		}
		const key = unescapePointer(segment);
		const byName: JsonNode | undefined = node.properties?.[key];
		if (byName) {
			node = byName;
			continue;
		}
		const patterns: Array<[string, JsonNode]> = node.patternProperties ? Object.entries(node.patternProperties) : [];
		const matched: JsonNode | undefined = patterns.find(([pattern]) => new RegExp(pattern).test(key))?.[1];
		if (matched) {
			node = matched;
			continue;
		}
		const shape: JsonNode | undefined = objectShapes(node)[0];
		if (!shape) return undefined;
		node = shape.properties?.[key] ?? patterns[0]?.[1];
	}
	return node;
}

/** Literal values a node accepts, when it is a closed set. */
function literalsOf(node: JsonNode): string[] | undefined {
	const members = unionMembers(node);
	if (members) {
		// A union may mix literals with plain types (`boolean | "auto"`). List the
		// literals and the types together, so the message covers every member
		// instead of naming only one of them.
		const described = members.map((member) => {
			if (member.const !== undefined) return JSON.stringify(member.const);
			if (member.enum) return `one of ${member.enum.map((value) => JSON.stringify(value)).join(", ")}`;
			return member.type ? `${/^[aeiou]/i.test(member.type) ? "an" : "a"} ${member.type}` : undefined;
		});
		return described.some((entry) => entry === undefined) ? undefined : [...new Set(described as string[])];
	}
	const values = node.enum ? [...node.enum] : node.const !== undefined ? [node.const] : [];
	return values.length > 0 ? values.map((value) => JSON.stringify(value)) : undefined;
}

/**
 * Walk the document once, recording unknown keys and a translation from the raw
 * pointer TypeBox produces to a correctly escaped one.
 *
 * The translation exists because TypeBox builds `instancePath` by joining raw
 * key text with `/`. For a record key that contains a slash, such as
 * `modelTriggerRatios["vendor/model.3"]`, the raw path is indistinguishable from
 * two nested levels, so the reported path would point at a key that does not
 * exist.
 */
interface Walk {
	readonly unknown: string[];
	readonly canonical: Map<string, string>;
}

function walkDocument(schema: JsonNode, document: unknown, pointer = "", rawPath = ""): Walk {
	const unknown: string[] = [];
	const canonical = new Map<string, string>();

	const visit = (node: JsonNode, value: unknown, pointerPath: string, raw: string): void => {
		canonical.set(raw, pointerPath);
		if (Array.isArray(value)) {
			if (!node.items) return;
			value.forEach((entry, index) => {
				visit(node.items!, entry, `${pointerPath}/${index}`, `${raw}/${index}`);
			});
			return;
		}
		if (value === null || typeof value !== "object") return;

		const shapes = objectShapes(node);
		if (shapes.length === 0) return;

		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			const escaped = escapePointer(key);
			const childPointer = `${pointerPath}/${escaped}`;
			const childRaw = `${raw}/${key}`;

			let child: JsonNode | undefined;
			for (const shape of shapes) {
				child = shape.properties?.[key];
				if (child) break;
				const patterns = shape.patternProperties ? Object.entries(shape.patternProperties) : [];
				child = patterns.find(([pattern]) => new RegExp(pattern).test(key))?.[1];
				if (child) break;
			}

			if (!child) {
				// Every shape that reached this point rejected the key.
				unknown.push(childPointer);
				continue;
			}
			visit(child, entry, childPointer, childRaw);
		}
	};

	visit(schema, document, pointer, rawPath);
	return { unknown, canonical };
}

/**
 * Fields the loaders compare case-insensitively after trimming.
 *
 * `normalizeStepPermissionPresetId` and `normalizeStepPermissionMode` both call
 * `trim().toLowerCase()`, so `"Ask"` and `"  full-access  "` are valid values.
 * JSON Schema cannot express a case-insensitive enum, so the copy is normalized
 * before it is validated — the alternative is rejecting a file the runtime
 * honors.
 */
const CASE_INSENSITIVE_PATHS = [
	["permissionPreset"],
	["permissionMode"],
	["approvalMode"],
	["nonInteractiveApproval"],
	["noninteractiveApproval"],
	["approval", "preset"],
	["approval", "mode"],
	["approval", "nonInteractive"],
	["approval", "noninteractive"],
	["tools", "approval", "preset"],
	["tools", "approval", "mode"],
	["tools", "approval", "nonInteractive"],
	["tools", "approval", "noninteractive"],
	// `parseHttpIdleTimeoutMs` lowercases and trims before comparing.
	["httpIdleTimeoutMs"],
	["websocketConnectTimeoutMs"],
] as const;

/** A copy with those fields lowercased and trimmed. */
function normalizeCaseInsensitiveFields(document: Record<string, unknown>): Record<string, unknown> {
	const normalized = structuredClone(document);
	for (const path of CASE_INSENSITIVE_PATHS) {
		let node: Record<string, unknown> | undefined = normalized;
		for (const segment of path.slice(0, -1)) {
			const child: unknown = node?.[segment];
			node =
				child && typeof child === "object" && !Array.isArray(child)
					? (child as Record<string, unknown>)
					: undefined;
		}
		const leaf = path[path.length - 1]!;
		const value = node?.[leaf];
		if (node && typeof value === "string") node[leaf] = value.trim().toLowerCase();
	}
	return normalized;
}

/**
 * TypeBox stops collecting after eight errors by default, which would make a
 * file with more problems look like it had eight. The limit is raised for the
 * duration of one validation and restored after, so the process-wide setting
 * other callers see is unchanged.
 */
function withRaisedErrorLimit<T>(run: () => T): T {
	const previous = TypeBoxSettings.Get().maxErrors;
	TypeBoxSettings.Set({ maxErrors: 10_000 });
	try {
		return run();
	} finally {
		TypeBoxSettings.Set({ maxErrors: previous });
	}
}

/** Validate one document, returning its problems. */
export function checkConfigDocument(file: string, document: unknown, target: "config" | "models"): ConfigProblem[] {
	return withRaisedErrorLimit(() => checkConfigDocumentInner(file, document, target));
}

function checkConfigDocumentInner(file: string, document: unknown, target: "config" | "models"): ConfigProblem[] {
	const validator = target === "models" ? validateModels : validateConfig;
	const schema = (target === "models" ? modelsSchemaJson : ConfigTomlSchema) as unknown as JsonNode;
	// The file is validated as written, not after the load path's legacy
	// rewrites. Migrating first would report a path the user cannot find: a bad
	// `queueMode` would come back as `/steeringMode`, and a value the rewrite
	// drops (`retry.maxDelayMs = "abc"`) would disappear from the report
	// entirely. Those keys are in the schema instead, so a file that uses one is
	// valid and a malformed one is still visible here.
	const candidate =
		target === "config" && document && typeof document === "object" && !Array.isArray(document)
			? normalizeCaseInsensitiveFields(document as Record<string, unknown>)
			: document;
	if (validator.Check(candidate)) return [];

	const walk = walkDocument(schema, candidate);
	const reportedUnknown = new Set(walk.unknown);
	const problems: ConfigProblem[] = [];

	for (const pointerPath of [...reportedUnknown].sort()) {
		const segments = pointerPath.split("/").filter((segment) => segment.length > 0);
		const name = unescapePointer(segments[segments.length - 1] ?? "");
		const parent = nodeAtPath(schema, `/${segments.slice(0, -1).join("/")}`);
		const suggestion = nearestKey(name, parent);
		problems.push({
			file,
			path: pointerPath,
			kind: "unknown",
			message: [
				`this build (${STEPCODE_VERSION.value}) does not read "${name}", so the setting has no effect`,
				suggestion ? `did you mean "${suggestion}"?` : undefined,
			]
				.filter(Boolean)
				.join("; "),
		});
	}

	const canonicalPath = (error: TLocalizedValidationError): string =>
		walk.canonical.get(error.instancePath) ?? error.instancePath;

	const insideUnknown = (path: string): boolean => {
		for (const known of reportedUnknown) if (path === known || path.startsWith(`${known}/`)) return true;
		return false;
	};

	// Two passes: collect first, decide second. Deciding while collecting made the
	// result depend on the order TypeBox happened to report errors in, and a
	// union with both literal and non-literal members produced two messages for
	// the same path.
	const literalFailures = new Map<string, string[]>();
	const typeFailures = new Map<string, string[]>();
	const collectionFailures = new Map<string, string[]>();
	const direct: Array<{ path: string; message: string }> = [];
	const seen = new Set<string>();
	const errors = validator.Errors(candidate).map((error) => ({ error, path: canonicalPath(error) }));

	/**
	 * Whether something below this path already explains the failure.
	 *
	 * Unknown keys are recorded by the walk rather than by TypeBox, so they have
	 * to be included: `packages = [{ source: "x", bogus: 1 }]` is a valid object
	 * with one unknown field, and the union summary would contradict that.
	 */
	const hasFailedDescendant = (path: string): boolean =>
		errors.some(({ path: other }) => other.startsWith(`${path}/`) && other !== path) ||
		[...reportedUnknown].some((known) => known.startsWith(`${path}/`));

	for (const { error, path } of errors) {
		if (path && insideUnknown(path)) continue;
		const node = nodeAtPath(schema, path);

		if (error.keyword === "const" || error.keyword === "enum") {
			const list = literalFailures.get(path) ?? [];
			list.push(error.message);
			literalFailures.set(path, list);
			continue;
		}
		if (error.keyword === "anyOf" || error.keyword === "oneOf") continue;
		// Reported by the walk with a better message.
		if (error.keyword === "additionalProperties") continue;

		if (error.keyword === "type" && node && unionMembers(node)) {
			// The union's own `type` failure is a summary of its members. It is
			// worth reporting only when nothing below it failed: a failure inside
			// an object member already says what is wrong, and the parent message
			// would contradict it.
			const list = typeFailures.get(path) ?? [];
			list.push(describeType(error));
			typeFailures.set(path, list);
			continue;
		}

		// A `collection` limit on an object or array is also a summary; the
		// concrete failure inside it is the useful one.
		if ((error.keyword === "minItems" || error.keyword === "maxItems") && node) {
			const list = collectionFailures.get(path) ?? [];
			list.push(error.message);
			collectionFailures.set(path, list);
			continue;
		}

		direct.push({ path, message: error.message });
	}

	// One message per field. A union with a constrained member produces one plain
	// failure per member (`pattern`, `type`), and listing them separately makes
	// the same value look like several problems.
	const byField = new Map<string, string[]>();
	for (const { path, message } of direct) {
		const list = byField.get(path) ?? [];
		if (!list.includes(message)) list.push(message);
		byField.set(path, list);
	}
	for (const [path, messages] of byField) {
		// The union summary below covers the field when one is available.
		if (literalFailures.has(path) || typeFailures.has(path)) continue;
		const key = `${path}\0${messages.join("|")}`;
		if (seen.has(key)) continue;
		seen.add(key);
		problems.push({ file, path, kind: "invalid", message: messages.join("; ") });
	}

	for (const [path, messages] of collectionFailures) {
		if (hasFailedDescendant(path)) continue;
		problems.push({ file, path, kind: "invalid", message: messages[0]! });
	}

	// One message per field, whatever mix of literal and non-literal members it
	// accepts: `hyperlink` is a boolean or "auto", and saying only one of those
	// is worse than saying neither.
	for (const path of new Set([...literalFailures.keys(), ...typeFailures.keys()])) {
		const node = nodeAtPath(schema, path);
		const literals = node ? literalsOf(node) : undefined;
		const shapes = [...new Set(typeFailures.get(path) ?? [])];
		// A failure inside a member already explains the value; the union summary
		// would contradict it (`packages = [{ source: 1 }]` is a valid object).
		if (hasFailedDescendant(path)) continue;

		const parts = [...new Set([...shapes, ...(literals ?? [])])];
		const message =
			parts.length > 0
				? `must be ${parts.join(" or ")}`
				: `value is not accepted (${literalFailures.get(path)?.[0] ?? "no member matched"})`;
		problems.push({ file, path, kind: "invalid", message });
	}

	return problems;
}

/**
 * The declared key closest to `name`, when it is close enough to be a typo.
 *
 * A one-character edit covers the common case (`baseurl` for `baseUrl`,
 * `triggerRation` for `triggerRatio`). Below that threshold the key is more
 * likely from a newer release, and guessing would be misleading.
 */
function nearestKey(name: string, parent: JsonNode | undefined): string | undefined {
	const candidates = Object.keys(parent?.properties ?? {});
	if (candidates.length === 0) return undefined;
	const lower = name.toLowerCase();
	let best: { key: string; distance: number } | undefined;
	for (const candidate of candidates) {
		const distance = editDistance(lower, candidate.toLowerCase());
		if (!best || distance < best.distance) best = { key: candidate, distance };
	}
	// Case-only differences and one edit, but never for a very short key where
	// almost anything is "one edit away".
	const allowed = Math.max(1, Math.floor(name.length / 3));
	return best && best.distance <= allowed ? best.key : undefined;
}

/** Levenshtein distance, capped by the caller's threshold. */
function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	let previous = Array.from({ length: cols }, (_, index) => index);
	for (let row = 1; row < rows; row += 1) {
		const current = [row];
		for (let col = 1; col < cols; col += 1) {
			const substitution = a[row - 1] === b[col - 1] ? 0 : 1;
			current[col] = Math.min(previous[col]! + 1, current[col - 1]! + 1, previous[col - 1]! + substitution);
		}
		previous = current;
	}
	return previous[cols - 1]!;
}

/** The JSON type an error names, phrased for a reader. */
function describeType(error: TLocalizedValidationError): string {
	const expected = (error.params as { type?: string }).type;
	if (!expected) return "the expected shape";
	const article = /^[aeiou]/i.test(expected) ? "an" : "a";
	return `${article} ${expected}`;
}

function nodeAtPath(schema: JsonNode, pointer: string): JsonNode | undefined {
	const segments = pointer.split("/").filter((segment) => segment.length > 0);
	return nodeAt(schema, segments);
}

function parseProblem(file: string, error: unknown): ConfigProblem {
	return {
		file,
		path: "",
		message: error instanceof Error ? error.message : String(error),
		kind: "parse",
	};
}

/**
 * Check the files that exist. A missing project file is normal, so it is
 * skipped rather than reported.
 */
export function checkStepConfigFiles(paths: {
	readonly globalSettings: string;
	readonly projectSettings: string;
	readonly models: string;
}): ConfigCheckResult {
	const problems: ConfigProblem[] = [];
	const checkedFiles: string[] = [];
	const notes: string[] = [];

	// Editor support needs one comment line the file may not have. Saying so is
	// cheaper than writing into a file the user has not asked us to change.
	const globalHeader = existsSync(paths.globalSettings)
		? readFileSync(paths.globalSettings, "utf8").split("\n").slice(0, 20).join("\n")
		: "";
	if (globalHeader.length > 0 && !/^#:schema\s/m.test(globalHeader)) {
		notes.push(
			`add "${configSchemaDirective()}" as the first line of ${paths.globalSettings} for editor completions`,
		);
	}

	// The project file is read here so a contributor can check it before
	// committing, but a launch only loads it when the project is trusted. Saying
	// so keeps "this file is wrong" from reading as "this is what runs".
	if (existsSync(paths.projectSettings)) {
		notes.push(`${paths.projectSettings}: only loaded when the project is trusted; use --approve or /trust`);
	}

	for (const file of [paths.globalSettings, paths.projectSettings]) {
		if (!existsSync(file)) continue;
		checkedFiles.push(file);
		try {
			problems.push(...checkConfigDocument(file, parseToml(readFileSync(file, "utf8")), "config"));
		} catch (error) {
			problems.push(parseProblem(file, error));
		}
	}

	if (existsSync(paths.models)) {
		checkedFiles.push(paths.models);
		try {
			// models.json accepts `//` comments, so the loader strips them first.
			const parsed: unknown = JSON.parse(stripJsonComments(stripBom(readFileSync(paths.models, "utf8"))));
			problems.push(...checkConfigDocument(paths.models, parsed, "models"));
		} catch (error) {
			problems.push(parseProblem(paths.models, error));
		}
	}

	return { problems, checkedFiles, notes };
}
