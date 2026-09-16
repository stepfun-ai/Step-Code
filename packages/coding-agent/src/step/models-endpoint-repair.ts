/**
 * Idempotent repair of the Step endpoint recorded in `models.json`.
 *
 * Earlier Harness releases persisted a complete operation URL, an OpenAI
 * dialect, or a `models-proxy` route into the Step provider entry. Those files
 * are still on disk and the CLI would keep sending requests to an endpoint that
 * no longer answers, with no diagnostic pointing at the cause. This pass
 * rewrites only the product-owned Step provider and its built-in model ids, so
 * a deliberately configured custom provider is left alone.
 *
 * The pass is read-only when nothing is stale: it returns false without writing
 * unless a value actually changed.
 */

import { readFile, writeFile } from "node:fs/promises";
import {
	normalizeStepAnthropicBaseUrl,
	STEP_MODELS,
	STEP_PROVIDER_DEFAULTS,
	STEP_PROVIDER_ID,
} from "../features/step-provider/index.ts";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** `$VAR` / `!cmd` indirection is resolved later; never rewrite it to a literal. */
function isConfigReference(value: string): boolean {
	return value.startsWith("$") || value.startsWith("!");
}

const STEP_BUILTIN_MODEL_IDS = new Set(STEP_MODELS.map((model) => model.id.toLowerCase()));

function isStepBuiltinModel(value: string | undefined): boolean {
	return value !== undefined && STEP_BUILTIN_MODEL_IDS.has(value.toLowerCase());
}

/**
 * Resolve the endpoint a repair should target.
 *
 * An explicit environment override stays effective while old files are being
 * repaired. A malformed override is ignored rather than persisted, so the
 * provider resolver's normal diagnostics still describe the real problem.
 */
export function canonicalStepBaseUrl(env: Record<string, string | undefined> = process.env): string {
	const configured =
		env.STEP_PROVIDER_API_URL?.trim() ||
		env.STEP_API_URL?.trim() ||
		env.STEP_BASE_URL?.trim() ||
		env.STEPFUN_MESSAGES_ENDPOINT?.trim() ||
		env.STEP_CLI_STEP_PLAN_API_URL?.trim();
	if (!configured) return STEP_PROVIDER_DEFAULTS.apiBaseUrl;
	const normalized = normalizeStepAnthropicBaseUrl(configured);
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") return normalized;
	} catch {
		// Fall through to the production default.
	}
	return STEP_PROVIDER_DEFAULTS.apiBaseUrl;
}

/**
 * Repair a built-in Step model written by an older release. Those releases
 * treated `provider` as a vendor/route alias and could leave a built-in id with
 * an OpenAI API or a complete operation URL. The Step provider owns these ids
 * and always speaks the Anthropic Messages dialect from its canonical prefix.
 */
function normalizeStepBuiltinProvider(
	provider: JsonObject,
	canonicalBaseUrl: string,
	warnings: string[],
	path: string,
): boolean {
	const entries = Array.isArray(provider.models)
		? provider.models.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => entry !== undefined)
		: [];
	if (!entries.some((entry) => isStepBuiltinModel(asString(entry.id)))) return false;

	let changed = false;
	if (asString(provider.api) !== "anthropic-messages") {
		provider.api = "anthropic-messages";
		changed = true;
		warnings.push(`${path}.api: normalized the built-in Step catalog to "anthropic-messages".`);
	}
	const providerBaseUrl = asString(provider.baseUrl);
	if (!providerBaseUrl || (!isConfigReference(providerBaseUrl) && providerBaseUrl !== canonicalBaseUrl)) {
		provider.baseUrl = canonicalBaseUrl;
		changed = true;
		warnings.push(`${path}.baseUrl: normalized the built-in Step catalog endpoint.`);
	}
	for (const [index, entry] of entries.entries()) {
		if (!isStepBuiltinModel(asString(entry.id))) continue;
		if (asString(entry.api) !== "anthropic-messages") {
			entry.api = "anthropic-messages";
			changed = true;
			warnings.push(`${path}.models[${index}].api: normalized the built-in Step model API.`);
		}
		const modelBaseUrl = asString(entry.baseUrl);
		if (!modelBaseUrl || (!isConfigReference(modelBaseUrl) && modelBaseUrl !== canonicalBaseUrl)) {
			entry.baseUrl = canonicalBaseUrl;
			changed = true;
		}
	}
	return changed;
}

/** Normalize the Step provider entry in `targetPath`. Returns whether it wrote. */
export async function normalizeStepModelsFile(
	targetPath: string,
	warnings: string[] = [],
	canonicalBaseUrl: string = STEP_PROVIDER_DEFAULTS.apiBaseUrl,
): Promise<boolean> {
	let content: string;
	try {
		content = await readFile(targetPath, "utf8");
	} catch {
		return false;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(stripBom(content)));
	} catch {
		// ModelConfig will surface the regular parse diagnostic. Do not make a
		// repair pass turn a launch into a second, less useful error.
		return false;
	}
	const root = asObject(parsed);
	const providers = asObject(root?.providers);
	const provider = asObject(providers?.[STEP_PROVIDER_ID]);
	if (!root || !providers || !provider) return false;

	const entries = Array.isArray(provider.models)
		? provider.models.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => entry !== undefined)
		: [];
	const declaredApi = asString(provider.api);
	// Built-in ids are product-owned even when an older release copied proxy wire
	// metadata onto this provider. Normalize those before the URL-only pass below.
	let changed = normalizeStepBuiltinProvider(
		provider,
		canonicalBaseUrl,
		warnings,
		`${targetPath}.providers.${STEP_PROVIDER_ID}`,
	);
	// The Step extension supplies Anthropic as the provider default when the user
	// file omits `api`. Mirror that composition rule even if the catalog also
	// contains an explicitly configured OpenAI model.
	const inferredAnthropic = declaredApi === "anthropic-messages" || declaredApi === undefined;
	const normalizeField = (entry: JsonObject, path: string, api: string | undefined): void => {
		if (api !== "anthropic-messages") return;
		const value = asString(entry.baseUrl);
		if (!value) return;
		const normalized = normalizeStepAnthropicBaseUrl(value);
		if (normalized === value) return;
		entry.baseUrl = normalized;
		changed = true;
		warnings.push(`${path}: normalized the Step Anthropic endpoint.`);
	};

	if (inferredAnthropic)
		normalizeField(provider, `${targetPath}.providers.${STEP_PROVIDER_ID}.baseUrl`, "anthropic-messages");
	for (const [index, entry] of entries.entries()) {
		const api = asString(entry.api) ?? (inferredAnthropic ? "anthropic-messages" : declaredApi);
		normalizeField(entry, `${targetPath}.providers.${STEP_PROVIDER_ID}.models[${index}].baseUrl`, api);
	}

	if (!changed) return false;
	try {
		await writeFile(targetPath, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf8" });
		return true;
	} catch (error) {
		warnings.push(
			`${targetPath}: could not persist the normalized Step endpoint (${error instanceof Error ? error.message : String(error)}).`,
		);
		return false;
	}
}
