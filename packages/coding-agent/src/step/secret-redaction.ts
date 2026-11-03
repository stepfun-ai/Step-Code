/**
 * Credential redaction for durable text that leaves the machine.
 *
 * This intentionally targets credentials rather than general PII: a feedback
 * comment or a session transcript still needs its ordinary words, URLs, and
 * paths to be useful, while credential-shaped values must not survive the exit
 * boundary. It is the harness counterpart of stepcode's
 * `packages/utils/src/secret-redaction.ts`; the feedback bundle relies on it
 * because pi's session store writes raw JSON with no write-time redaction.
 *
 * Unlabelled low-entropy strings are deliberately not guessed: treating every
 * opaque id or hash as a secret would corrupt the transcript while providing no
 * reliable guarantee.
 */

const REDACTED_SECRET = "<redacted:secret>";
const MAX_EMBEDDED_JSON_DEPTH = 8;
const MAX_STRUCTURE_DEPTH = 64;
const MAX_STREAMED_SECRET_SCAN_LINE_CHARACTERS = 24 * 1024 * 1024;
const MAX_STREAMED_SECRET_CANDIDATES = 256;
const MAX_STREAMED_SECRET_CANDIDATE_CHARACTERS = 64 * 1024;

const PRIVATE_KEY_PATTERN = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/gu;
const PRIVATE_KEY_BEGIN_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u;

const KNOWN_SECRET_PATTERNS: readonly RegExp[] = [
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/gu,
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/gu,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
	/\bglpat-[A-Za-z0-9_-]{20,}\b/gu,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
	/\b(?:npm|pypi)-[A-Za-z0-9_-]{20,}\b/gu,
	/\bAIza[0-9A-Za-z_-]{20,}\b/gu,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
	/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/gu,
	/\bwhsec_[A-Za-z0-9]{12,}\b/gu,
	/\b(?:sk|pk|ak)-[A-Za-z0-9_-]{12,}\b/gu,
];

const SECRET_LABEL = String.raw`(?:\b(?:api[\s_-]*key|client[\s_-]*secret|app[\s_-]*secret|consumer[\s_-]*secret|signing[\s_-]*secret|webhook[\s_-]*secret|secret[\s_-]*(?:access[\s_-]*)?key|private[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|auth[\s_-]*token|bearer[\s_-]*token|session[\s_-]*token|service[\s_-]*token|token|password|passwd|passcode|passphrase|pwd|secret)\b|密码|口令|密钥|令牌)`;
const SECRET_SEPARATOR = String.raw`(?:=|:|：|\bis\b\s*[:=：]?|\bwas\b\s*[:=：]?|是\s*[:：]?)`;
const TRAILING_LABELED_SECRET = new RegExp(`(${SECRET_LABEL}\\s*${SECRET_SEPARATOR}\\s*)$`, "iu");

const QUOTED_LABELED_SECRET = new RegExp(`(${SECRET_LABEL}\\s*${SECRET_SEPARATOR}\\s*)(["'\`])([^\\r\\n]*?)\\2`, "giu");

// An unquoted password/passphrase may legitimately contain spaces. Stop only
// at an explicit record delimiter; treating the first word as the whole value
// would leave the remainder (and later echoes) in durable logs.
const UNQUOTED_LABELED_SECRET = new RegExp(
	`(${SECRET_LABEL}\\s*${SECRET_SEPARATOR}\\s*)([^\\r\\n\\u2028\\u2029,，;；)}\\]]+)`,
	"giu",
);

// Used only on text that could not be parsed as a balanced JSON span. Parsed
// objects take the structured path below, where keys are never string-replaced.
const QUOTED_MALFORMED_JSON_SECRET = new RegExp(
	`((?:"${SECRET_LABEL}"|'${SECRET_LABEL}')\\s*:\\s*)(["'\`])([^\\r\\n]*?)\\2`,
	"giu",
);

const UNQUOTED_MALFORMED_JSON_SECRET = new RegExp(
	`((?:"${SECRET_LABEL}"|'${SECRET_LABEL}')\\s*:\\s*)([^\\r\\n\\u2028\\u2029,，;；)}\\]]+)`,
	"giu",
);

const SECRET_ENV_ASSIGNMENT =
	/\b((?:[A-Z][A-Z0-9]*_)*(?:API_KEY|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CLIENT_SECRET|APP_SECRET|PRIVATE_KEY|SECRET_KEY|SECRET)\s*=\s*)("[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;]+)/gu;

const SECRET_CLI_ARGUMENT =
	/((?:--)(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|bearer[-_]?token|session[-_]?token|service[-_]?token|token|password|passwd|passphrase|client[-_]?secret|secret[-_]?key|secret)(?:=|\s+))("[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;]+)/giu;

// Balanced JSON is removed from the free-form pass before this runs, so a
// header value can safely extend through commas to the physical line ending
// without consuming adjacent structured fields.
const SENSITIVE_HEADER_VALUE = /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)([^\r\n]+)/giu;

const AUTH_SCHEME_VALUE = /(\b(bearer|basic)\s+)([A-Za-z0-9._~+/=-]+)/giu;

const TRAILING_SENSITIVE_HEADER_LABEL = /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)$/iu;

const URL_USERINFO_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@?#]*:)([^/\s?#]+)(@)/giu;

const URL_SECRET_PARAMETER =
	/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret)=)([^&#\s]*)/giu;

const SENSITIVE_CANONICAL_KEYS = new Set([
	"api_key",
	"x_api_key",
	"authorization",
	"proxy_authorization",
	"password",
	"passwd",
	"passcode",
	"passphrase",
	"pwd",
	"secret",
	"client_secret",
	"app_secret",
	"consumer_secret",
	"signing_secret",
	"webhook_secret",
	"secret_key",
	"secret_access_key",
	"private_key",
	"access_token",
	"refresh_token",
	"auth_token",
	"bearer_token",
	"session_token",
	"service_token",
	"id_token",
	"token",
	"credential",
	"credentials",
	"cookie",
	"set_cookie",
	"密码",
	"口令",
	"密钥",
	"令牌",
]);

const SENSITIVE_COLLAPSED_KEYS = new Set([...SENSITIVE_CANONICAL_KEYS].map((key) => key.replaceAll("_", "")));

const JSON_SCHEMA_KEYWORDS = new Set([
	"$anchor",
	"$comment",
	"$defs",
	"$dynamicAnchor",
	"$dynamicRef",
	"$id",
	"$ref",
	"$schema",
	"$vocabulary",
	"additionalItems",
	"additionalProperties",
	"allOf",
	"anyOf",
	"const",
	"contains",
	"contentEncoding",
	"contentMediaType",
	"contentSchema",
	"default",
	"definitions",
	"dependentRequired",
	"dependentSchemas",
	"deprecated",
	"description",
	"else",
	"enum",
	"examples",
	"exclusiveMaximum",
	"exclusiveMinimum",
	"format",
	"if",
	"items",
	"maxContains",
	"maxItems",
	"maxLength",
	"maxProperties",
	"maximum",
	"minContains",
	"minItems",
	"minLength",
	"minProperties",
	"minimum",
	"multipleOf",
	"not",
	"oneOf",
	"pattern",
	"patternProperties",
	"prefixItems",
	"properties",
	"propertyNames",
	"readOnly",
	"required",
	"then",
	"title",
	"type",
	"unevaluatedItems",
	"unevaluatedProperties",
	"uniqueItems",
	"writeOnly",
]);

const SENSITIVE_SCHEMA_VALUE_KEYS = new Set(["const", "default", "enum", "example", "examples"]);
const SENSITIVE_SCHEMA_MAP_KEYS = new Set(["$defs", "definitions", "dependentSchemas", "patternProperties"]);
const NESTED_SCHEMA_VALUE_KEYS = new Set([
	"additionalItems",
	"additionalProperties",
	"allOf",
	"anyOf",
	"contains",
	"contentSchema",
	"else",
	"if",
	"items",
	"not",
	"oneOf",
	"prefixItems",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

const JSON_SCHEMA_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
const STRING_SCHEMA_CONSTRAINT_KEYS = new Set([
	"$dynamicRef",
	"$id",
	"$ref",
	"$schema",
	"contentEncoding",
	"contentMediaType",
	"format",
	"pattern",
]);
const NUMBER_SCHEMA_CONSTRAINT_KEYS = new Set([
	"exclusiveMaximum",
	"exclusiveMinimum",
	"maxContains",
	"maxItems",
	"maxLength",
	"maxProperties",
	"maximum",
	"minContains",
	"minItems",
	"minLength",
	"minProperties",
	"minimum",
	"multipleOf",
]);
const BOOLEAN_SCHEMA_CONSTRAINT_KEYS = new Set(["deprecated", "readOnly", "uniqueItems", "writeOnly"]);
const OBJECT_SCHEMA_CONTAINER_KEYS = new Set([
	"$defs",
	"definitions",
	"dependentRequired",
	"dependentSchemas",
	"patternProperties",
	"properties",
]);
const discoveredSecretPatterns = new WeakMap<ReadonlySet<string>, RegExp>();

interface JsonSpan {
	start: number;
	end: number;
	value: object;
}

interface RedactionResult {
	value: unknown;
	changed: boolean;
}

interface RedactedObjectKeys {
	value: Record<string, unknown>;
	changed: boolean;
}

export type SecretRedactionScanResult =
	| { status: "ready"; value: string }
	| {
			status: "unsafe";
			reason: "candidate-budget-exceeded" | "invalid-jsonl-record" | "redaction-failed" | "source-line-too-large";
	  };
type SecretRedactionUnsafeReason = Extract<SecretRedactionScanResult, { status: "unsafe" }>["reason"];

export interface SecretRedactionCollector {
	write(chunk: string): void;
	finish(): SecretRedactionScanResult;
}

export interface BoundedSecretRedactor {
	redact(value: string): SecretRedactionScanResult;
	observeSensitive(value: string): SecretRedactionScanResult;
	invalidate(): void;
}

interface BoundedSecretCandidateState {
	values: Set<string>;
	characters: number;
}

/**
 * Redacts credential-shaped fragments in free-form text, including JSON payloads
 * embedded in strings or carried inside line protocols such as JSONL and SSE.
 */
export function redactSecretString(value: string): string {
	try {
		const discoveredSecrets = new Set<string>();
		collectSecretCandidatesFromString(value, 0, discoveredSecrets);
		return redactStringValue(value, 0, discoveredSecrets);
	} catch {
		// A malformed or pathologically nested input must never bypass the exit
		// boundary. The plain-text pass still recognizes explicit credential forms.
		try {
			return redactPlainText(value, new Set());
		} catch {
			return value.length === 0 ? "" : REDACTED_SECRET;
		}
	}
}

/** Keeps a bounded credential vocabulary for redacting later stream records. */
export function createBoundedSecretRedactor(): BoundedSecretRedactor {
	const candidates: BoundedSecretCandidateState = { values: new Set<string>(), characters: 0 };
	let unsafeReason: SecretRedactionUnsafeReason | undefined;

	return {
		redact(value: string): SecretRedactionScanResult {
			if (unsafeReason) return { status: "unsafe", reason: unsafeReason };
			const previousCandidateCount = candidates.values.size;
			unsafeReason = collectBoundedSecretCandidates(value, candidates);
			if (unsafeReason) return { status: "unsafe", reason: unsafeReason };
			try {
				if (candidates.values.size !== previousCandidateCount) {
					cacheDiscoveredSecretPattern(candidates.values);
				}
				return { status: "ready", value: redactStringValue(value, 0, candidates.values) };
			} catch {
				unsafeReason = "redaction-failed";
				return { status: "unsafe", reason: unsafeReason };
			}
		},
		observeSensitive(value: string): SecretRedactionScanResult {
			if (unsafeReason) return { status: "unsafe", reason: unsafeReason };
			const previousCandidateCount = candidates.values.size;
			unsafeReason = collectBoundedSecretCandidates(JSON.stringify({ password: value }), candidates);
			if (unsafeReason) return { status: "unsafe", reason: unsafeReason };
			if (candidates.values.size !== previousCandidateCount) {
				cacheDiscoveredSecretPattern(candidates.values);
			}
			return { status: "ready", value: REDACTED_SECRET };
		},
		invalidate(): void {
			unsafeReason ??= "source-line-too-large";
		},
	};
}

/**
 * Redacts a bounded target using credentials discovered while streaming a
 * larger source. Unique candidates accumulate only within explicit count and
 * character budgets, then are applied to the target once at EOF. Each nonempty
 * physical source line must be a complete JSON object record; malformed, scalar,
 * array, or pretty-
 * printed multiline input is unsafe because its credential context may cross
 * the tail boundary. Oversized lines are likewise rejected.
 */
export function createSecretRedactionCollector(target: string): SecretRedactionCollector {
	let pendingLine = "";
	let unsafeReason: SecretRedactionUnsafeReason | undefined;
	let finishedResult: SecretRedactionScanResult | undefined;
	const candidates: BoundedSecretCandidateState = { values: new Set<string>(), characters: 0 };

	const collectCandidates = (value: string): void => {
		if (unsafeReason) return;
		unsafeReason = collectBoundedSecretCandidates(value, candidates);
	};

	const consumeLine = (line: string): void => {
		if (line.trim().length > 0 && !isCompleteJsonRecord(line)) {
			unsafeReason = "invalid-jsonl-record";
			return;
		}
		collectCandidates(line);
	};

	collectCandidates(target);

	return {
		write(chunk: string): void {
			if (finishedResult || unsafeReason || chunk.length === 0) return;
			let cursor = 0;
			let newlineIndex = chunk.indexOf("\n", cursor);
			while (newlineIndex >= 0) {
				const fragment = chunk.slice(cursor, newlineIndex);
				if (pendingLine.length + fragment.length > MAX_STREAMED_SECRET_SCAN_LINE_CHARACTERS) {
					unsafeReason = "source-line-too-large";
					pendingLine = "";
					return;
				}
				consumeLine(`${pendingLine}${fragment}`);
				pendingLine = "";
				cursor = newlineIndex + 1;
				newlineIndex = chunk.indexOf("\n", cursor);
			}

			const fragment = chunk.slice(cursor);
			if (pendingLine.length + fragment.length > MAX_STREAMED_SECRET_SCAN_LINE_CHARACTERS) {
				unsafeReason = "source-line-too-large";
				pendingLine = "";
				return;
			}
			pendingLine += fragment;
		},
		finish(): SecretRedactionScanResult {
			if (finishedResult) return finishedResult;
			if (unsafeReason) {
				finishedResult = { status: "unsafe", reason: unsafeReason };
				return finishedResult;
			}
			if (pendingLine.length > 0) consumeLine(pendingLine);
			pendingLine = "";
			if (unsafeReason) {
				finishedResult = { status: "unsafe", reason: unsafeReason };
				return finishedResult;
			}
			try {
				cacheDiscoveredSecretPattern(candidates.values);
				finishedResult = { status: "ready", value: redactStringValue(target, 0, candidates.values) };
			} catch {
				finishedResult = { status: "unsafe", reason: "redaction-failed" };
			}
			return finishedResult;
		},
	};
}

function collectBoundedSecretCandidates(
	value: string,
	state: BoundedSecretCandidateState,
): SecretRedactionUnsafeReason | undefined {
	try {
		const discoveredSecrets = new Set<string>();
		collectSecretCandidatesFromString(value, 0, discoveredSecrets);
		for (const candidate of discoveredSecrets) {
			if (state.values.has(candidate)) continue;
			if (
				state.values.size >= MAX_STREAMED_SECRET_CANDIDATES ||
				state.characters + candidate.length > MAX_STREAMED_SECRET_CANDIDATE_CHARACTERS
			) {
				return "candidate-budget-exceeded";
			}
			state.values.add(candidate);
			state.characters += candidate.length;
		}
		return undefined;
	} catch {
		return "redaction-failed";
	}
}

export function hasTrailingSensitiveLabel(value: string): boolean {
	return trailingSensitiveLabel(value) !== undefined;
}

function trailingSensitiveLabel(value: string): string | undefined {
	const labeledSecret = TRAILING_LABELED_SECRET.exec(value)?.[1];
	const header = labeledSecret ?? TRAILING_SENSITIVE_HEADER_LABEL.exec(value)?.[1];
	if (header) return header;
	const quotedKey = /(["'])([^"'\r\n]+)\1\s*:\s*$/u.exec(value);
	return quotedKey?.[2] && isSensitiveKey(quotedKey[2]) ? quotedKey[0] : undefined;
}

function isCompleteJsonRecord(value: string): boolean {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
	} catch {
		return false;
	}
}

function collectSecretCandidates(
	value: unknown,
	structureDepth: number,
	embeddedJsonDepth: number,
	schemaProperties: boolean,
	discoveredSecrets: Set<string>,
): void {
	if (typeof value === "string") {
		collectSecretCandidatesFromString(value, embeddedJsonDepth, discoveredSecrets);
		return;
	}
	if (!value || typeof value !== "object" || structureDepth >= MAX_STRUCTURE_DEPTH) {
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			collectSecretCandidates(entry, structureDepth + 1, embeddedJsonDepth, false, discoveredSecrets);
		}
		return;
	}

	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return;
	}

	const record = value as Record<string, unknown>;
	const jsonSchema = isJsonSchemaRecord(record);
	for (const [key, entry] of Object.entries(record)) {
		collectPlainTextCandidates(key, discoveredSecrets);
		const schemaDefinition = schemaProperties && isJsonSchemaDefinition(entry);
		if (isSensitiveKey(key)) {
			if (schemaDefinition) {
				collectSensitiveSchemaCandidates(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
			} else {
				collectSensitiveValue(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
			}
			continue;
		}
		collectSecretCandidates(
			entry,
			structureDepth + 1,
			embeddedJsonDepth,
			jsonSchema && key === "properties",
			discoveredSecrets,
		);
	}
}

function collectSensitiveValue(
	value: unknown,
	structureDepth: number,
	embeddedJsonDepth: number,
	discoveredSecrets: Set<string>,
): void {
	if (typeof value === "string") {
		addSecretCandidate(value, discoveredSecrets);
		collectSecretCandidatesFromString(value, embeddedJsonDepth, discoveredSecrets);
		return;
	}
	if (typeof value === "number" || typeof value === "bigint") {
		addSecretCandidate(String(value), discoveredSecrets);
		return;
	}
	if (!value || typeof value !== "object" || structureDepth >= MAX_STRUCTURE_DEPTH) {
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			collectSensitiveValue(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
		}
		return;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return;
	for (const [key, entry] of Object.entries(value)) {
		collectPlainTextCandidates(key, discoveredSecrets);
		collectSensitiveValue(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
	}
}

function collectSensitiveSchemaCandidates(
	value: unknown,
	structureDepth: number,
	embeddedJsonDepth: number,
	discoveredSecrets: Set<string>,
): void {
	if (!value || typeof value !== "object" || structureDepth >= MAX_STRUCTURE_DEPTH) return;
	if (Array.isArray(value)) {
		for (const entry of value) {
			collectSensitiveSchemaCandidates(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
		}
		return;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return;

	for (const [key, entry] of Object.entries(value)) {
		collectPlainTextCandidates(key, discoveredSecrets);
		if (SENSITIVE_SCHEMA_VALUE_KEYS.has(key) || !JSON_SCHEMA_KEYWORDS.has(key)) {
			collectSensitiveValue(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
		} else if (SENSITIVE_SCHEMA_MAP_KEYS.has(key)) {
			collectSensitiveSchemaMapCandidates(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
		} else if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) {
			collectSensitiveSchemaPropertyCandidates(
				entry as Record<string, unknown>,
				structureDepth + 1,
				embeddedJsonDepth,
				discoveredSecrets,
			);
		} else if (NESTED_SCHEMA_VALUE_KEYS.has(key)) {
			collectSensitiveSchemaCandidates(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
		}
		// Type, description, and validation constraints describe the schema. They
		// are intentionally not candidates for propagation into sibling values.
	}
}

function collectSensitiveSchemaMapCandidates(
	value: unknown,
	structureDepth: number,
	embeddedJsonDepth: number,
	discoveredSecrets: Set<string>,
): void {
	if (!isPlainRecord(value) || structureDepth >= MAX_STRUCTURE_DEPTH) {
		collectSensitiveValue(value, structureDepth, embeddedJsonDepth, discoveredSecrets);
		return;
	}
	for (const [key, entry] of Object.entries(value)) {
		collectPlainTextCandidates(key, discoveredSecrets);
		if (isSchemaContainerValue(entry)) {
			collectSensitiveSchemaCandidates(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
		} else {
			collectSensitiveValue(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
		}
	}
}

function collectSensitiveSchemaPropertyCandidates(
	properties: Record<string, unknown>,
	structureDepth: number,
	embeddedJsonDepth: number,
	discoveredSecrets: Set<string>,
): void {
	if (structureDepth >= MAX_STRUCTURE_DEPTH) return;
	for (const [key, entry] of Object.entries(properties)) {
		collectPlainTextCandidates(key, discoveredSecrets);
		if (isJsonSchemaDefinition(entry)) {
			collectSensitiveSchemaCandidates(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
		} else if (isSensitiveKey(key)) {
			collectSensitiveValue(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
		} else {
			collectSecretCandidates(entry, structureDepth + 1, embeddedJsonDepth, false, discoveredSecrets);
		}
	}
}

function collectSecretCandidatesFromString(
	value: string,
	embeddedJsonDepth: number,
	discoveredSecrets: Set<string>,
): void {
	const spans = value.includes("{") || value.includes("[") ? findJsonSpans(value) : [];
	if (spans.length === 0) {
		collectPlainTextCandidates(value, discoveredSecrets);
		return;
	}

	let cursor = 0;
	for (const span of spans) {
		collectPlainTextCandidates(value.slice(cursor, span.start), discoveredSecrets);
		if (embeddedJsonDepth < MAX_EMBEDDED_JSON_DEPTH) {
			collectSecretCandidates(span.value, 0, embeddedJsonDepth + 1, false, discoveredSecrets);
		}
		cursor = span.end;
	}
	collectPlainTextCandidates(value.slice(cursor), discoveredSecrets);
}

function collectPlainTextCandidates(value: string, discoveredSecrets: Set<string>): void {
	forEachPatternMatch(QUOTED_MALFORMED_JSON_SECRET, value, (match) => {
		addSecretCandidate(match[3], discoveredSecrets);
	});
	forEachPatternMatch(UNQUOTED_MALFORMED_JSON_SECRET, value, (match) => {
		addSecretCandidate(match[2], discoveredSecrets);
	});
	forEachPatternMatch(PRIVATE_KEY_PATTERN, value, (match) => {
		addSecretCandidate(match[0], discoveredSecrets);
		const label = match[1];
		if (!label) return;
		const beginMarker = `-----BEGIN ${label}-----`;
		const endMarker = `-----END ${label}-----`;
		const endIndex = match[0].lastIndexOf(endMarker);
		const body = match[0].slice(beginMarker.length, endIndex < 0 ? undefined : endIndex);
		for (const line of body.split(/\r?\n/u)) {
			let remaining = line;
			let nestedBegin = PRIVATE_KEY_BEGIN_PATTERN.exec(remaining);
			while (nestedBegin) {
				addSecretCandidate(remaining.slice(0, nestedBegin.index), discoveredSecrets);
				remaining = remaining.slice(nestedBegin.index + nestedBegin[0].length);
				nestedBegin = PRIVATE_KEY_BEGIN_PATTERN.exec(remaining);
			}
			addSecretCandidate(remaining, discoveredSecrets);
		}
	});
	forEachPatternMatch(SENSITIVE_HEADER_VALUE, value, (match) => {
		addSecretCandidate(match[2], discoveredSecrets);
	});
	forEachPatternMatch(AUTH_SCHEME_VALUE, value, (match) => {
		if (isPlausibleAuthCredential(match[2] ?? "", match[3] ?? "")) {
			addSecretCandidate(match[3], discoveredSecrets);
		}
	});
	forEachPatternMatch(URL_USERINFO_PASSWORD, value, (match) => {
		addSecretCandidate(match[2], discoveredSecrets);
	});
	forEachPatternMatch(URL_SECRET_PARAMETER, value, (match) => {
		addSecretCandidate(match[2], discoveredSecrets);
	});
	forEachPatternMatch(SECRET_ENV_ASSIGNMENT, value, (match) => {
		addSecretCandidate(match[2], discoveredSecrets);
	});
	forEachPatternMatch(SECRET_CLI_ARGUMENT, value, (match) => {
		addSecretCandidate(match[2], discoveredSecrets);
	});
	forEachPatternMatch(QUOTED_LABELED_SECRET, value, (match) => {
		addSecretCandidate(match[3], discoveredSecrets);
	});
	forEachPatternMatch(UNQUOTED_LABELED_SECRET, value, (match) => {
		addSecretCandidate(match[2], discoveredSecrets);
	});
	for (const pattern of KNOWN_SECRET_PATTERNS) {
		forEachPatternMatch(pattern, value, (match) => {
			addSecretCandidate(match[0], discoveredSecrets);
		});
	}
}

function addSecretCandidate(value: string | undefined, discoveredSecrets: Set<string>): void {
	if (!value) {
		return;
	}

	const candidate = stripMatchingQuotes(value.trim());
	if (candidate.length < 8 || isSecretPlaceholder(candidate)) {
		return;
	}

	discoveredSecrets.add(candidate);
}

function stripMatchingQuotes(value: string): string {
	if (value.length < 2) {
		return value;
	}
	const first = value[0];
	const last = value[value.length - 1];
	return first === last && (first === '"' || first === "'" || first === "`") ? value.slice(1, -1) : value;
}

function forEachPatternMatch(pattern: RegExp, value: string, visit: (match: RegExpExecArray) => void): void {
	pattern.lastIndex = 0;
	let match = pattern.exec(value);
	while (match !== null) {
		visit(match);
		if (match[0].length === 0) {
			pattern.lastIndex += 1;
		}
		match = pattern.exec(value);
	}
	pattern.lastIndex = 0;
}

function redactStringValue(value: string, embeddedJsonDepth: number, discoveredSecrets: ReadonlySet<string>): string {
	const spans = value.includes("{") || value.includes("[") ? findJsonSpans(value) : [];
	if (spans.length === 0) {
		return redactPlainText(value, discoveredSecrets);
	}

	let output = "";
	let cursor = 0;
	for (const span of spans) {
		output += redactPlainText(value.slice(cursor, span.start), discoveredSecrets);
		if (embeddedJsonDepth >= MAX_EMBEDDED_JSON_DEPTH) {
			output += REDACTED_SECRET;
		} else {
			const redacted = redactValue(span.value, 0, embeddedJsonDepth + 1, false, discoveredSecrets);
			output += redacted.changed
				? stringifyRedactedJson(redacted.value, value.slice(span.start, span.end))
				: value.slice(span.start, span.end);
		}
		cursor = span.end;
	}
	output += redactPlainText(value.slice(cursor), discoveredSecrets);
	return output;
}

function redactPlainText(value: string, discoveredSecrets: ReadonlySet<string>): string {
	let output = value.replace(
		QUOTED_MALFORMED_JSON_SECRET,
		(match, prefix: string, quote: string, candidate: string) =>
			isSecretPlaceholder(candidate) ? match : `${prefix}${quote}${REDACTED_SECRET}${quote}`,
	);
	output = output.replace(UNQUOTED_MALFORMED_JSON_SECRET, (match, prefix: string, candidate: string) =>
		isSecretPlaceholder(candidate) ? match : `${prefix}${REDACTED_SECRET}`,
	);
	output = output.replace(PRIVATE_KEY_PATTERN, REDACTED_SECRET);
	output = output.replace(SENSITIVE_HEADER_VALUE, `$1${REDACTED_SECRET}`);
	output = output.replace(AUTH_SCHEME_VALUE, (match, prefix: string, scheme: string, candidate: string) =>
		isPlausibleAuthCredential(scheme, candidate) ? `${prefix}${REDACTED_SECRET}` : match,
	);
	output = output.replace(URL_USERINFO_PASSWORD, `$1${REDACTED_SECRET}$3`);
	output = output.replace(URL_SECRET_PARAMETER, `$1${encodeURIComponent(REDACTED_SECRET)}`);
	output = output.replace(SECRET_ENV_ASSIGNMENT, (_match, prefix: string) => `${prefix}${REDACTED_SECRET}`);
	output = output.replace(SECRET_CLI_ARGUMENT, (_match, prefix: string) => `${prefix}${REDACTED_SECRET}`);
	output = output.replace(QUOTED_LABELED_SECRET, (match, prefix: string, quote: string, candidate: string) =>
		isSecretPlaceholder(candidate) ? match : `${prefix}${quote}${REDACTED_SECRET}${quote}`,
	);
	output = output.replace(UNQUOTED_LABELED_SECRET, (match, prefix: string, candidate: string) =>
		isSecretPlaceholder(candidate) ? match : `${prefix}${REDACTED_SECRET}`,
	);
	for (const pattern of KNOWN_SECRET_PATTERNS) {
		output = output.replace(pattern, REDACTED_SECRET);
	}

	return redactDiscoveredSecrets(output, discoveredSecrets);
}

function redactDiscoveredSecrets(value: string, discoveredSecrets: ReadonlySet<string>): string {
	if (discoveredSecrets.size === 0) return value;
	const pattern = discoveredSecretPatterns.get(discoveredSecrets);
	if (pattern) {
		pattern.lastIndex = 0;
		return value.replace(pattern, REDACTED_SECRET);
	}

	let output = value;
	for (const secret of [...discoveredSecrets].sort((left, right) => right.length - left.length)) {
		output = output.split(secret).join(REDACTED_SECRET);
	}
	return output;
}

function cacheDiscoveredSecretPattern(discoveredSecrets: ReadonlySet<string>): void {
	if (discoveredSecrets.size === 0) return;
	const pattern = new RegExp(
		[...discoveredSecrets]
			.sort((left, right) => right.length - left.length)
			.map((secret) => secret.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&"))
			.join("|"),
		"g",
	);
	discoveredSecretPatterns.set(discoveredSecrets, pattern);
}

function redactValue(
	value: unknown,
	structureDepth: number,
	embeddedJsonDepth: number,
	schemaProperties: boolean,
	discoveredSecrets: ReadonlySet<string>,
): RedactionResult {
	if (typeof value === "string") {
		const redacted = redactStringValue(value, embeddedJsonDepth, discoveredSecrets);
		return { value: redacted, changed: redacted !== value };
	}
	if (!value || typeof value !== "object") {
		return { value, changed: false };
	}
	if (structureDepth >= MAX_STRUCTURE_DEPTH) {
		return { value: REDACTED_SECRET, changed: true };
	}
	if (Array.isArray(value)) {
		let changed = false;
		const entries = value.map((entry) => {
			const redacted = redactValue(entry, structureDepth + 1, embeddedJsonDepth, false, discoveredSecrets);
			changed ||= redacted.changed;
			return redacted.value;
		});
		return { value: entries, changed };
	}

	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return { value: REDACTED_SECRET, changed: true };
	}

	const record = value as Record<string, unknown>;
	const jsonSchema = isJsonSchemaRecord(record);
	let changed = false;
	const entries = Object.entries(record).map(([key, entry]): [string, unknown] => {
		const schemaDefinition = schemaProperties && isJsonSchemaDefinition(entry);
		const redacted =
			isSensitiveKey(key) && schemaDefinition
				? redactSensitiveSchemaDefinition(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets)
				: isSensitiveKey(key)
					? redactSensitiveValue(entry, structureDepth + 1)
					: redactValue(
							entry,
							structureDepth + 1,
							embeddedJsonDepth,
							jsonSchema && key === "properties",
							discoveredSecrets,
						);
		changed ||= redacted.changed;
		return [key, redacted.value];
	});
	const redactedObject = materializeRedactedObject(entries);
	return { value: redactedObject.value, changed: changed || redactedObject.changed };
}

function redactSensitiveSchemaDefinition(
	value: unknown,
	structureDepth: number,
	embeddedJsonDepth: number,
	discoveredSecrets: ReadonlySet<string>,
): RedactionResult {
	if (typeof value === "boolean") return { value, changed: false };
	if (!value || typeof value !== "object" || structureDepth >= MAX_STRUCTURE_DEPTH) {
		return redactSensitiveValue(value, structureDepth);
	}
	if (Array.isArray(value)) {
		let changed = false;
		const entries = value.map((entry) => {
			const redacted = redactSensitiveSchemaDefinition(
				entry,
				structureDepth + 1,
				embeddedJsonDepth,
				discoveredSecrets,
			);
			changed ||= redacted.changed;
			return redacted.value;
		});
		return { value: entries, changed };
	}

	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return { value: REDACTED_SECRET, changed: true };
	}

	let changed = false;
	const entries = Object.entries(value).map(([key, entry]): [string, unknown] => {
		let redacted: RedactionResult;
		if (SENSITIVE_SCHEMA_VALUE_KEYS.has(key)) {
			redacted = redactSensitiveValue(entry, structureDepth + 1);
		} else if (SENSITIVE_SCHEMA_MAP_KEYS.has(key)) {
			redacted = redactSensitiveSchemaMap(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
		} else if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) {
			redacted = redactSchemaProperties(
				entry as Record<string, unknown>,
				structureDepth + 1,
				embeddedJsonDepth,
				discoveredSecrets,
			);
		} else if (NESTED_SCHEMA_VALUE_KEYS.has(key)) {
			redacted = redactSensitiveSchemaDefinition(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
		} else if (JSON_SCHEMA_KEYWORDS.has(key)) {
			redacted = redactValue(entry, structureDepth + 1, embeddedJsonDepth, false, discoveredSecrets);
		} else {
			// Unknown fields do not prove that an object is schema metadata. Within a
			// sensitive property definition, treat their values as credential data.
			redacted = redactSensitiveValue(entry, structureDepth + 1);
		}
		changed ||= redacted.changed;
		return [key, redacted.value];
	});
	const redactedObject = materializeRedactedObject(entries);
	return { value: redactedObject.value, changed: changed || redactedObject.changed };
}

function redactSensitiveSchemaMap(
	value: unknown,
	structureDepth: number,
	embeddedJsonDepth: number,
	discoveredSecrets: ReadonlySet<string>,
): RedactionResult {
	if (!isPlainRecord(value) || structureDepth >= MAX_STRUCTURE_DEPTH) {
		return redactSensitiveValue(value, structureDepth);
	}
	let changed = false;
	const entries = Object.entries(value).map(([key, entry]): [string, unknown] => {
		const redacted = redactSensitiveSchemaDefinition(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets);
		changed ||= redacted.changed;
		return [key, redacted.value];
	});
	const redactedObject = materializeRedactedObject(entries);
	return { value: redactedObject.value, changed: changed || redactedObject.changed };
}

function redactSchemaProperties(
	properties: Record<string, unknown>,
	structureDepth: number,
	embeddedJsonDepth: number,
	discoveredSecrets: ReadonlySet<string>,
): RedactionResult {
	if (structureDepth >= MAX_STRUCTURE_DEPTH) return { value: REDACTED_SECRET, changed: true };
	let changed = false;
	const entries = Object.entries(properties).map(([key, entry]): [string, unknown] => {
		const redacted = isJsonSchemaDefinition(entry)
			? redactSensitiveSchemaDefinition(entry, structureDepth + 1, embeddedJsonDepth, discoveredSecrets)
			: isSensitiveKey(key)
				? redactSensitiveValue(entry, structureDepth + 1)
				: redactValue(entry, structureDepth + 1, embeddedJsonDepth, false, discoveredSecrets);
		changed ||= redacted.changed;
		return [key, redacted.value];
	});
	const redactedObject = materializeRedactedObject(entries);
	return { value: redactedObject.value, changed: changed || redactedObject.changed };
}

function redactSensitiveValue(value: unknown, structureDepth: number): RedactionResult {
	if (value === null || value === undefined) {
		return { value, changed: false };
	}
	if (typeof value === "string") {
		return { value: REDACTED_SECRET, changed: value !== REDACTED_SECRET };
	}
	if (typeof value === "number") {
		return { value: 0, changed: value !== 0 };
	}
	if (typeof value === "bigint") {
		return { value: 0n, changed: value !== 0n };
	}
	if (typeof value === "boolean") {
		return { value: false, changed: value };
	}
	if (structureDepth >= MAX_STRUCTURE_DEPTH) {
		return { value: REDACTED_SECRET, changed: true };
	}
	if (Array.isArray(value)) {
		return {
			value: value.map((entry) => redactSensitiveValue(entry, structureDepth + 1).value),
			changed: true,
		};
	}
	if (typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype === Object.prototype || prototype === null) {
			const entries = Object.entries(value).map(([key, entry]): [string, unknown] => [
				key,
				redactSensitiveValue(entry, structureDepth + 1).value,
			]);
			return {
				value: materializeRedactedObject(entries).value,
				changed: true,
			};
		}
	}
	return { value: REDACTED_SECRET, changed: true };
}

function materializeRedactedObject(entries: readonly (readonly [string, unknown])[]): RedactedObjectKeys {
	const reservedSourceKeys = new Set(entries.map(([key]) => key));
	const usedKeys = new Set<string>();
	const redactedEntries: [string, unknown][] = [];
	let collisionIndex = 2;
	let changed = false;

	for (const [key, value] of entries) {
		const baseKey = redactDeterministicCredentialShapes(key);
		let outputKey = baseKey;
		if (baseKey !== key) {
			changed = true;
			while (reservedSourceKeys.has(outputKey) || usedKeys.has(outputKey)) {
				outputKey = `${baseKey}#${collisionIndex}`;
				collisionIndex += 1;
			}
		}
		usedKeys.add(outputKey);
		redactedEntries.push([outputKey, value]);
	}

	return { value: Object.fromEntries(redactedEntries), changed };
}

function redactDeterministicCredentialShapes(value: string): string {
	// Object keys must not receive secrets discovered from sibling values: doing
	// so would rewrite ordinary opaque identifiers. Explicit credential syntax is
	// independently safe to redact in either a key or a value.
	return redactPlainText(value, new Set());
}

function findJsonSpans(value: string): JsonSpan[] {
	const spans: JsonSpan[] = [];
	const closers: string[] = [];
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index] ?? "";
		if (start < 0) {
			if (character === "{" || character === "[") {
				start = index;
				closers.push(character === "{" ? "}" : "]");
			}
			continue;
		}

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}

		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{" || character === "[") {
			closers.push(character === "{" ? "}" : "]");
			continue;
		}
		if (character !== "}" && character !== "]") {
			continue;
		}
		if (closers.at(-1) !== character) {
			start = -1;
			closers.length = 0;
			inString = false;
			escaped = false;
			continue;
		}

		closers.pop();
		if (closers.length > 0) {
			continue;
		}

		const end = index + 1;
		try {
			const parsed = JSON.parse(value.slice(start, end)) as unknown;
			if (parsed && typeof parsed === "object") {
				spans.push({ start, end, value: parsed });
			}
		} catch {
			// A balanced prose fragment is not necessarily JSON.
		}
		start = -1;
		inString = false;
		escaped = false;
	}

	return spans;
}

function stringifyRedactedJson(value: unknown, source: string): string {
	try {
		return JSON.stringify(value, null, source.includes("\n") ? 2 : undefined) ?? REDACTED_SECRET;
	} catch {
		return REDACTED_SECRET;
	}
}

function isPlausibleAuthCredential(scheme: string, candidate: string): boolean {
	if (scheme.toLowerCase() === "basic") {
		if (candidate.length < 8 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(candidate) || candidate.length % 4 === 1) {
			return false;
		}
		try {
			const decoded = Buffer.from(candidate, "base64");
			const canonical = decoded.toString("base64").replace(/=+$/u, "");
			const text = decoded.toString("utf8");
			return (
				canonical === candidate.replace(/=+$/u, "") &&
				!text.includes("\ufffd") &&
				/^[^\u0000-\u001f\u007f]*:[^\u0000-\u001f\u007f]*$/u.test(text)
			);
		} catch {
			return false;
		}
	}

	return candidate.length >= 12;
}

function isSensitiveKey(key: string): boolean {
	const canonical = canonicalizeKey(key);
	if (SENSITIVE_CANONICAL_KEYS.has(canonical) || SENSITIVE_COLLAPSED_KEYS.has(canonical.replaceAll("_", ""))) {
		return true;
	}

	return (
		/(?:^|_)(?:api_key|client_secret|app_secret|consumer_secret|signing_secret|webhook_secret|secret_access_key|private_key|access_token|refresh_token|auth_token|bearer_token|session_token|service_token|password|passwd|passcode|passphrase|credential|credentials|secret)$/u.test(
			canonical,
		) ||
		/(?:^|_)(?:密码|口令|密钥|令牌)$/u.test(canonical) ||
		(/(?:^|_)[a-z0-9]+_token$/u.test(canonical) &&
			!/(?:^|_)(?:input|output|prompt|completion|reasoning|cached|total|max|min|budget|selected|estimated|remaining)_token$/u.test(
				canonical,
			))
	);
}

function canonicalizeKey(key: string): string {
	return key
		.trim()
		.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9㐀-鿿]+/gu, "_")
		.replace(/^_+|_+$/gu, "");
}

function isSecretPlaceholder(value: string): boolean {
	const candidate = stripMatchingQuotes(value.trim());
	return (
		candidate.length === 0 ||
		candidate === REDACTED_SECRET ||
		/^<[^>]+>$/u.test(candidate) ||
		/^\*+$/u.test(candidate) ||
		/^(?:string|secret|password|token|api[_ -]?key|your[_ -].*|example|placeholder)$/iu.test(candidate)
	);
}

function isJsonSchemaDefinition(value: unknown): boolean {
	if (typeof value === "boolean") {
		return true;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return hasStrongJsonSchemaSignal(value as Record<string, unknown>);
}

function hasStrongJsonSchemaSignal(value: Record<string, unknown>): boolean {
	if (isValidJsonSchemaType(value.type)) return true;
	if (Object.hasOwn(value, "const") || Array.isArray(value.enum)) return true;
	if (Array.isArray(value.required) && value.required.every((entry) => typeof entry === "string")) return true;

	for (const [key, entry] of Object.entries(value)) {
		if (STRING_SCHEMA_CONSTRAINT_KEYS.has(key) && typeof entry === "string" && entry.length > 0) return true;
		if (NUMBER_SCHEMA_CONSTRAINT_KEYS.has(key) && typeof entry === "number" && Number.isFinite(entry)) return true;
		if (BOOLEAN_SCHEMA_CONSTRAINT_KEYS.has(key) && typeof entry === "boolean") return true;
		if (OBJECT_SCHEMA_CONTAINER_KEYS.has(key) && isPlainRecord(entry)) return true;
		if (NESTED_SCHEMA_VALUE_KEYS.has(key) && isSchemaContainerValue(entry)) return true;
	}
	return false;
}

function isValidJsonSchemaType(value: unknown): boolean {
	if (typeof value === "string") return JSON_SCHEMA_TYPES.has(value);
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((entry) => typeof entry === "string" && JSON_SCHEMA_TYPES.has(entry))
	);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isSchemaContainerValue(value: unknown): boolean {
	return typeof value === "boolean" || isPlainRecord(value) || Array.isArray(value);
}

function isJsonSchemaRecord(value: Record<string, unknown>): boolean {
	if (!value.properties || typeof value.properties !== "object" || Array.isArray(value.properties)) {
		return false;
	}
	const propertyDefinitions = Object.values(value.properties);

	return (
		value.type === "object" ||
		(Array.isArray(value.type) && value.type.includes("object")) ||
		Array.isArray(value.required) ||
		"additionalProperties" in value ||
		propertyDefinitions.some(isJsonSchemaDefinition)
	);
}
