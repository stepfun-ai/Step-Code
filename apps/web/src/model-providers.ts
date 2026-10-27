/**
 * Model providers: the user's custom `models.json` declarations, as the settings
 * page manages them.
 *
 * Two files are involved and they hold different things. `models.json` owns the
 * declaration — address, protocol, catalog — and is a file users read, copy
 * between machines and paste into bug reports. `auth.json` owns the secret. This
 * module keeps that split, so a key typed in the form never lands in the file
 * that gets shared.
 */

import { join } from "node:path";
import {
	AuthStorage,
	type DiscoveredModel,
	discoverModels,
	getStepAuthPath,
	ModelDiscoveryError,
	ModelRuntime,
	normalizeProviderBaseUrl,
	readModelsJsonProviders,
	readStoredCredential,
	resolveStepConfigRoot,
	updateModelsJsonProvider,
} from "@step-harness/coding-agent";
import { SettingsError } from "./settings.ts";
import { importStepgoModels, type StepgoModelImportResult } from "./stepgo-import.ts";

/**
 * First-start import of the providers and key a local stepgo launcher (`sc`)
 * injects, so the models page is filled without typing anything. It writes the
 * same `models.json` / `auth.json` this module manages, into the paths this
 * host reads, and runs once: afterwards the providers are ordinary custom
 * providers the user maintains here. Never throws; one line is logged when
 * something was imported or went wrong, and never a key.
 */
export async function importLocalStepgoModels(
	log: (line: string) => void = (line) => console.log(line),
): Promise<StepgoModelImportResult> {
	const result = await importStepgoModels({ modelsPath: modelsJsonPath(), authPath: modelsAuthPath() });
	if (result.status === "imported") {
		const parts = [`imported ${result.providers.length} provider(s) from stepgo`];
		if (result.providers.length > 0) parts.push(result.providers.join(", "));
		if (result.existing.length > 0) parts.push(`kept existing: ${result.existing.join(", ")}`);
		log(`[models] ${parts.join("; ")}`);
		for (const warning of result.warnings) log(`[models] stepgo import: ${warning}`);
	}
	return result;
}

/**
 * A provider declared in `models.json`, as the models page lists it.
 *
 * Only custom declarations appear. The built-in catalog is not configurable and
 * this screen has no opinion about it; a provider the kernel ships is simply not
 * one of these rows.
 */
export interface WebModelProvider {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly api: string;
	readonly models: readonly WebModelEntry[];
	/** Where this provider's API key comes from; never the key itself. */
	readonly credential: "stored" | "configured" | "none";
}

/** One catalog entry of a provider, as `models.json` stores it. */
export interface WebModelEntry {
	readonly id: string;
	readonly name?: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly input?: readonly ("text" | "image")[];
	/** Whether the model takes a thinking effort; without it the composer offers only "off". */
	readonly reasoning?: boolean;
	/** The effort value sent for each level; `null` hides a level. */
	readonly thinkingLevelMap?: ThinkingLevelMap;
}

/** The levels a `thinkingLevelMap` may name (providers `ModelThinkingLevel`). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevelMap = Partial<Record<(typeof THINKING_LEVELS)[number], string | null>>;

/**
 * A `thinkingLevelMap` as `models.json` may hold it, or `undefined` when it is
 * not one. Reading is lenient (an unknown key is dropped so one hand edit does
 * not hide the row); {@link parseThinkingLevelMap} is the strict client check.
 */
function thinkingLevelMapOf(raw: unknown): ThinkingLevelMap | undefined {
	if (!isRecord(raw)) return undefined;
	const map: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) {
		const value = raw[level];
		if (typeof value === "string" || value === null) map[level] = value;
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

/** The provider id whose `auth.json` entry is the account login, not a custom key. */
const STEP_PROVIDER_ID = "step";

/** Provider ids a URL can address; the same shape `mcp_servers` names use. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/u;

/** Longest id accepted, so a URL segment and a settings key stay reasonable. */
const MAX_PROVIDER_ID = 64;

/** Protocols the form offers. The stored value is the schema identifier the kernel reads. */
export const MODEL_APIS: readonly string[] = ["openai-completions", "openai-responses", "anthropic-messages"];

/**
 * `models.json` sits beside `config.toml` and `auth.json` under the config root,
 * which a host may relocate through `STEP_CODING_AGENT_DIR`; recomputing it from
 * the home directory would write a second file the kernel never reads.
 */
function modelsJsonPath(): string {
	return join(resolveStepConfigRoot(), "models.json");
}

/** The credential file the kernel reads, honouring the host's own override. */
function modelsAuthPath(): string {
	return process.env.STEPCODE_AUTH_PATH?.trim() || join(resolveStepConfigRoot(), "auth.json");
}

function stringOf(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Provider ids that hold a stored credential.
 *
 * `AuthStorage.list` reports the id and type only, never a resolved key, so this
 * never reads a secret into a reply. An unreadable auth file reports every
 * provider as keyless, which is the safe direction: the row asks for a key, and
 * the editor can write one without disturbing what could not be read.
 */
async function storedCredentialIds(): Promise<Set<string>> {
	try {
		const entries = await AuthStorage.create(modelsAuthPath()).list();
		return new Set(entries.map((entry) => entry.providerId));
	} catch {
		return new Set();
	}
}

function entryOf(raw: unknown): WebModelEntry | undefined {
	if (!isRecord(raw)) return undefined;
	const id = stringOf(raw.id);
	if (!id) return undefined;
	const input = (Array.isArray(raw.input) ? raw.input : []).filter(
		(value): value is "text" | "image" => value === "text" || value === "image",
	);
	const thinkingLevelMap = thinkingLevelMapOf(raw.thinkingLevelMap);
	return {
		id,
		...(stringOf(raw.name) ? { name: stringOf(raw.name) } : {}),
		...(typeof raw.contextWindow === "number" && raw.contextWindow > 0 ? { contextWindow: raw.contextWindow } : {}),
		...(typeof raw.maxTokens === "number" && raw.maxTokens > 0 ? { maxTokens: raw.maxTokens } : {}),
		...(input.length > 0 ? { input } : {}),
		...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
	};
}

/**
 * Whether a custom (bring-your-own-key) model can run a session without a Step
 * credential, so the sign-in gate is not required.
 *
 * Answered by the kernel's own availability check over `models.json` and the
 * credential file, the same inputs a session reads, and offline: no network
 * refresh. An unreadable configuration answers `false`, which only shows the
 * sign-in gate, and the gate itself offers the way to the models page.
 */
export async function hasUsableCustomModel(): Promise<boolean> {
	try {
		const runtime = await ModelRuntime.create({ authPath: getStepAuthPath(), modelsPath: modelsJsonPath() });
		await runtime.refresh({ allowNetwork: false });
		return runtime.getAvailableSnapshot().some((model) => model.provider !== STEP_PROVIDER_ID);
	} catch {
		return false;
	}
}

/** Every custom provider in `models.json`, sorted so the list is stable between reads. */
export async function listModelProviders(): Promise<WebModelProvider[]> {
	const stored = await storedCredentialIds();
	const providers: WebModelProvider[] = [];
	for (const [id, config] of Object.entries(readModelsJsonProviders(modelsJsonPath()))) {
		providers.push({
			id,
			name: stringOf(config.name) || id,
			baseUrl: stringOf(config.baseUrl),
			api: stringOf(config.api),
			models: (Array.isArray(config.models) ? config.models : [])
				.map(entryOf)
				.filter((entry): entry is WebModelEntry => entry !== undefined),
			credential: stored.has(id) ? "stored" : stringOf(config.apiKey) ? "configured" : "none",
		});
	}
	providers.sort((left, right) => left.id.localeCompare(right.id));
	return providers;
}

/** Validate an id from the client. */
export function checkProviderId(id: string): void {
	if (!PROVIDER_ID.test(id) || id.length > MAX_PROVIDER_ID) {
		throw new SettingsError(
			400,
			"Provider ID must use lowercase letters, digits, '.', '_' and '-', and start with one",
		);
	}
	if (id === STEP_PROVIDER_ID) {
		throw new SettingsError(400, `'${STEP_PROVIDER_ID}' is the account provider and cannot be redefined`);
	}
}

/** A positive whole number, or `undefined`; anything else is the caller's mistake. */
function positiveInt(value: unknown, field: string): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new SettingsError(400, `${field} must be a positive whole number`);
	}
	return value;
}

/** A `thinkingLevelMap` from the client: known levels only, each a string or `null`. */
function parseThinkingLevelMap(value: unknown, id: string): ThinkingLevelMap | undefined {
	if (value === undefined || value === null) return undefined;
	const field = `model '${id}' thinkingLevelMap`;
	if (!isRecord(value)) throw new SettingsError(400, `${field} must be an object`);
	const known: ReadonlySet<string> = new Set(THINKING_LEVELS);
	for (const [level, mapped] of Object.entries(value)) {
		if (!known.has(level)) throw new SettingsError(400, `${field} has an unknown level '${level}'`);
		if (typeof mapped !== "string" && mapped !== null) {
			throw new SettingsError(400, `${field}.${level} must be a string or null`);
		}
	}
	return thinkingLevelMapOf(value);
}

/** The model catalog from the client: an id per row is required, the rest is optional. */
function parseModelEntries(input: unknown): Array<Record<string, unknown>> {
	if (input === undefined) return [];
	if (!Array.isArray(input)) throw new SettingsError(400, "models must be an array");
	const seen = new Set<string>();
	return input.map((raw) => {
		if (!isRecord(raw)) throw new SettingsError(400, "every model must be an object");
		const id = stringOf(raw.id);
		if (!id) throw new SettingsError(400, "every model needs an id");
		if (seen.has(id)) throw new SettingsError(400, `duplicate model id '${id}'`);
		seen.add(id);
		const contextWindow = positiveInt(raw.contextWindow, `model '${id}' context window`);
		const maxTokens = positiveInt(raw.maxTokens, `model '${id}' max output tokens`);
		const input_ = (Array.isArray(raw.input) ? raw.input : []).filter(
			(value): value is "text" | "image" => value === "text" || value === "image",
		);
		const name = stringOf(raw.name);
		if (raw.reasoning !== undefined && typeof raw.reasoning !== "boolean") {
			throw new SettingsError(400, `model '${id}' reasoning must be true or false`);
		}
		const thinkingLevelMap = parseThinkingLevelMap(raw.thinkingLevelMap, id);
		return {
			id,
			...(name ? { name } : {}),
			...(contextWindow === undefined ? {} : { contextWindow }),
			...(maxTokens === undefined ? {} : { maxTokens }),
			...(input_.length > 0 ? { input: input_ } : {}),
			...(raw.reasoning === undefined ? {} : { reasoning: raw.reasoning }),
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		};
	});
}

export interface ModelProviderInput {
	readonly name?: unknown;
	readonly baseUrl?: unknown;
	readonly api?: unknown;
	readonly apiKey?: unknown;
	readonly models?: unknown;
}

/**
 * Build the declaration `models.json` stores.
 *
 * The API key is deliberately not part of it. A secret belongs in `auth.json`,
 * while `models.json` is a file users copy between machines and paste into bug
 * reports; the schema would accept an `apiKey` here, and this page still keeps
 * it out.
 */
export function parseModelProvider(input: ModelProviderInput): Record<string, unknown> {
	const typedUrl = stringOf(input.baseUrl);
	if (!typedUrl) throw new SettingsError(400, "API address is required");
	try {
		const parsed = new URL(typedUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
	} catch {
		throw new SettingsError(400, "API address must be an http(s) URL");
	}
	const api = stringOf(input.api);
	if (!api) throw new SettingsError(400, "API protocol is required");
	// The form accepts a gateway root or its /v1 spelling under every protocol;
	// the file stores the one this protocol's client appends its path to, so a
	// session reads it back unchanged.
	const baseUrl = normalizeProviderBaseUrl(typedUrl, api);
	const name = stringOf(input.name);
	const models = parseModelEntries(input.models);
	return {
		baseUrl,
		api,
		...(name ? { name } : {}),
		...(models.length > 0 ? { models } : {}),
	};
}

/**
 * Store (`key` set) or clear (`undefined`) one custom provider's API key.
 *
 * The entry is keyed by the provider id because that is the exact lookup the
 * kernel performs to resolve a request's auth — a composite name would leave the
 * key unreachable for both this page and a session. What keeps the account login
 * safe is the guard, not the spelling: `step` is refused, and an entry that is
 * not an api-key credential is never read or written here.
 */
export async function setStoredApiKey(id: string, key: string | undefined): Promise<void> {
	checkProviderId(id);
	const path = modelsAuthPath();
	const storage = AuthStorage.create(path);
	const existing = readStoredCredential(id, path);
	if (existing && existing.type !== "api_key") {
		throw new SettingsError(409, `Provider '${id}' is signed in; its credential is not an API key`);
	}
	if (key === undefined) {
		if (existing) await storage.delete(id);
		return;
	}
	await storage.modify(id, async () => ({ type: "api_key", key }));
}

/**
 * Create (`replace: false`, 409 when taken) or replace (`replace: true`, 404 when
 * missing) one provider, and store the key typed beside it.
 *
 * The declaration is written first and the credential second: a key with no
 * provider would be invisible and unusable, whereas a provider with no key is a
 * state the page already shows and the user can repair by editing. So a failed
 * credential write leaves a visible row rather than a stray secret.
 *
 * A stored key is write-only for this page — it is never sent back to the
 * browser — so a blank field means "leave it as it is" rather than "remove it".
 * `options.removeKey` is the explicit removal the editor sends when the user
 * asks for one; a typed key always wins over it.
 */
export async function saveModelProvider(
	id: string,
	input: ModelProviderInput,
	options: { replace: boolean; removeKey?: boolean },
): Promise<void> {
	checkProviderId(id);
	const declaration = parseModelProvider(input);
	const key = stringOf(input.apiKey);
	updateModelsJsonProvider(modelsJsonPath(), id, (existing) => {
		if (options.replace && !existing) throw new SettingsError(404, `Model provider '${id}' does not exist`);
		if (!options.replace && existing) throw new SettingsError(409, `Model provider '${id}' already exists`);
		// A hand-written literal key stays where it is: this form never displays it,
		// so replacing the declaration must not drop it. Only the key the page owns
		// (in auth.json) is managed here.
		const keepKey = existing?.apiKey === undefined ? {} : { apiKey: existing.apiKey };
		return { ...keepKey, ...declaration };
	});
	if (key) await setStoredApiKey(id, key);
	else if (options.removeKey) await setStoredApiKey(id, undefined);
}

/** Remove one provider and the key this page stored for it. */
export async function deleteModelProvider(id: string): Promise<void> {
	checkProviderId(id);
	updateModelsJsonProvider(modelsJsonPath(), id, (existing) => {
		if (!existing) throw new SettingsError(404, `Model provider '${id}' does not exist`);
		return undefined;
	});
	// Only an api-key credential this page could have written is cleared; an
	// account login for the same id would not be an api_key entry.
	await setStoredApiKey(id, undefined);
}

export interface DiscoverModelsInput {
	readonly providerId?: unknown;
	readonly baseUrl?: unknown;
	readonly api?: unknown;
	readonly apiKey?: unknown;
}

/**
 * The key a session would use for `providerId`, resolved by the kernel from the
 * credential file and `models.json` (stored entry first, then the declaration's
 * own key), or `undefined` when there is none or the id is not a custom provider.
 *
 * The key stays on the host: it is only attached to the outgoing request.
 */
async function storedProviderApiKey(providerId: string): Promise<string | undefined> {
	if (!PROVIDER_ID.test(providerId) || providerId.length > MAX_PROVIDER_ID || providerId === STEP_PROVIDER_ID) {
		return undefined;
	}
	const runtime = await ModelRuntime.create({ authPath: modelsAuthPath(), modelsPath: modelsJsonPath() });
	await runtime.refresh({ allowNetwork: false });
	return (await runtime.getAuth(providerId))?.auth.apiKey || undefined;
}

/**
 * Ask one endpoint which models it advertises, for the form's 获取可用模型 action.
 *
 * Nothing is stored: this answers for a declaration the user is still editing, so
 * a provider can be filled in and saved in one pass instead of save-then-return.
 * A key typed in the form is used for this request only; a blank key field means
 * "keep the stored key", as on save and in the connection test, so the stored
 * credential for `providerId` is used instead.
 *
 * A failure keeps the endpoint's own words where the protocol reported them (an
 * HTTP status, a JSON parse failure), and maps the rest to a 4xx that names what
 * the user can change: the address, the protocol, or the key.
 */
export async function discoverProviderModels(input: DiscoverModelsInput): Promise<DiscoveredModel[]> {
	const typedKey = stringOf(input.apiKey);
	const providerId = stringOf(input.providerId);
	const apiKey = typedKey || (providerId ? await storedProviderApiKey(providerId) : undefined);
	try {
		return await discoverModels({
			api: stringOf(input.api) || undefined,
			baseUrl: stringOf(input.baseUrl),
			apiKey,
		});
	} catch (error) {
		if (error instanceof ModelDiscoveryError) {
			const status = error.code === "http" ? 502 : 400;
			throw new SettingsError(status, error.message);
		}
		throw error;
	}
}

/** How long a connection test may take before it is reported unreachable. */
const MODEL_TEST_TIMEOUT_MS = 20_000;

export interface TestProviderModelInput {
	readonly providerId?: unknown;
	readonly baseUrl?: unknown;
	readonly api?: unknown;
	readonly apiKey?: unknown;
	readonly modelId?: unknown;
}

/**
 * Verify one model of the declaration **currently in the form** is callable: a
 * one-token ping through the kernel's own provider stack, built on a runtime
 * that reads no `models.json` — the declaration being edited may not be saved
 * yet, exactly like 获取可用模型. A key typed in the form wins; without one the
 * credential file's stored entry for `providerId` resolves (a blank key field
 * means "keep the stored key").
 *
 * Provider and transport failures land on the answer (`errorMessage`,
 * `stopReason: "error"`), not as rejections, so both are checked; a timeout is
 * translated to something the user can act on.
 */
export async function testProviderModel(input: TestProviderModelInput): Promise<void> {
	const providerId = stringOf(input.providerId);
	const modelId = stringOf(input.modelId);
	const typedUrl = stringOf(input.baseUrl);
	const api = stringOf(input.api);
	const typedKey = stringOf(input.apiKey);
	if (!providerId || !modelId || !typedUrl || !api) {
		throw new SettingsError(400, "providerId, baseUrl, api and modelId are required");
	}
	// A typed key must be the probe's only credential: a stored entry for the
	// provider id outranks a declaration key, which would hide a mistyped key
	// behind the working stored one. Pointing the runtime at a path that holds
	// nothing gives the typed key (and only it) a clean slate; without one, the
	// real credential file supplies the stored key, like a saved session.
	const runtime = await ModelRuntime.create({
		authPath: typedKey ? `${modelsAuthPath()}.probe` : modelsAuthPath(),
		modelsPath: null,
	});
	runtime.registerProvider(providerId, {
		baseUrl: normalizeProviderBaseUrl(typedUrl, api),
		api,
		...(typedKey ? { apiKey: typedKey } : {}),
		models: [
			{
				id: modelId,
				name: modelId,
				// The probe is about reachability, not capability: a model that
				// claims no thinking level keeps every adapter's request free of
				// effort parameters, which some gateways reject outright.
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 1000,
				thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
			},
		],
	});
	await runtime.refresh({ allowNetwork: false }).catch(() => {});
	const model = runtime.getModel(providerId, modelId);
	if (!model) throw new SettingsError(400, `Model not found: ${providerId}/${modelId}`);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), MODEL_TEST_TIMEOUT_MS);
	try {
		const answer = await runtime.completeSimple(
			model,
			{ messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
			{ maxTokens: 1, signal: controller.signal },
		);
		if (answer.errorMessage) throw new SettingsError(502, answer.errorMessage);
		if (answer.stopReason === "error") throw new SettingsError(502, "The provider rejected the request");
	} catch (caught) {
		if (controller.signal.aborted) {
			throw new SettingsError(
				504,
				`No answer within ${MODEL_TEST_TIMEOUT_MS / 1000}s — check the address and the key`,
			);
		}
		throw caught;
	} finally {
		clearTimeout(timeout);
	}
}
