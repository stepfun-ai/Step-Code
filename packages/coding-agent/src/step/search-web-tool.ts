import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@step-harness/agent-core";
import type { Credential } from "@step-harness/providers";
import { type Static, Type } from "typebox";
import { readStoredCredential } from "../core/auth-storage.ts";
import type { ExtensionContext, ToolDefinition } from "../core/extensions/types.ts";
import { STEP_PROVIDER_ID } from "../features/step-provider/index.ts";
import { readStepConfig, resolveStepConfigPath } from "./config-toml.ts";
import { resolveStepAgentDir } from "./environment.ts";
import { readStepLoginProfile } from "./login-flow.ts";
import { invokeRemoteMcpTool, type RemoteMcpToolInvocation, type RemoteMcpToolResult } from "./mcp-client.ts";
import type { StepLoginProfileId } from "./onboarding.ts";
import { findAdapter } from "./search/adapters.ts";
import { classifyFailure } from "./search/errors.ts";
import { buildSearchChain } from "./search/routing.ts";
import { runSearchChain, type SearchChainResult } from "./search/scheduler.ts";
import { callSearchProvider } from "./search/transport.ts";
import {
	SEARCH_CHAIN_MODES,
	type SearchAttempt,
	type SearchChainMode,
	type SearchFailure,
	type SearchHit,
	type SearchOutcome,
} from "./search/types.ts";

export { invokeRemoteMcpTool } from "./mcp-client.ts";

export const SEARCH_WEB_SERVER_NAME = "stepsearch";
export const SEARCH_WEB_TOOL_NAME = "web_search";
export const SEARCH_WEB_MAINLAND_URL = "https://api.stepfun.com/v1/mcp/web_search/mcp";
export const SEARCH_WEB_OVERSEA_URL = "https://api.stepfun.ai/v1/mcp/web_search/mcp";
export const SEARCH_WEB_PLAN_MAINLAND_URL = "https://api.stepfun.com/step_plan/v1/mcp/web_search/mcp";
export const SEARCH_WEB_PLAN_OVERSEA_URL = "https://api.stepfun.ai/step_plan/v1/mcp/web_search/mcp";
/**
 * Unrecognized login profiles fall back to the mainland platform endpoint.
 *
 * A profile is absent only when no login wrote one: an explicit `--api-key`, a
 * `STEPCODE_SEARCH_API_KEY` environment key, or a hand-written `auth.json`.
 * Those carry platform keys, because a Step Plan credential is only ever
 * obtained through `/login`, which always records a profile — and a plan login
 * from before profiles existed still resolves, through the legacy `"step"`
 * mapping in `readStepLoginProfile`. So the fallback is not a guess about an
 * unknown credential; it is the only kind of credential that can arrive here.
 */
export const SEARCH_WEB_DEFAULT_URL = SEARCH_WEB_MAINLAND_URL;

/**
 * One endpoint per login profile, mirroring the `baseUrl` split in
 * `./onboarding.ts`: the plan profiles bill the user's Step Plan quota through
 * `/step_plan/v1`, the platform profiles bill a pay-as-you-go API
 * account through `/v1`. Plan and platform must never share a row — sending a
 * plan credential to the platform endpoint silently charges the API account.
 */
const SEARCH_WEB_PROFILE_URLS: Record<StepLoginProfileId, string> = {
	step_plan: SEARCH_WEB_PLAN_MAINLAND_URL,
	step_plan_oversea: SEARCH_WEB_PLAN_OVERSEA_URL,
	platform_cn: SEARCH_WEB_MAINLAND_URL,
	platform_oversea: SEARCH_WEB_OVERSEA_URL,
};

const SEARCH_WEB_RESULT_COUNT = 10;
const MAX_SNIPPET_CHARS = 400;

/** Environment override for the search backend selection. */
export const SEARCH_PROVIDER_ENV = "STEPCODE_SEARCH_PROVIDER";

const searchWebSchema = Type.Object({
	query: Type.String({ description: "Search query text" }),
});

type SearchWebInput = Static<typeof searchWebSchema>;

export interface SearchWebToolOptions {
	/** Explicit endpoint override, mainly useful for embedded hosts and tests. */
	url?: string;
	/** Explicit search credential. It is never included in a tool result. */
	apiKey?: string;
	/** Step auth.json path used when no environment credential is present. */
	authPath?: string;
	/** Injected environment, kept public so credential resolution is testable. */
	env?: Record<string, string | undefined>;
	/**
	 * Backend selection. Defaults to `[search] provider` in config.toml, then
	 * `STEPCODE_SEARCH_PROVIDER`, then `auto`.
	 */
	provider?: SearchChainMode;
	/** Injected randomness for the free-provider order; kept testable. */
	random?: () => number;
}

export type SearchWebInvocation = RemoteMcpToolInvocation & {
	arguments: { query: string; n: number };
};

export type SearchWebMcpResult = RemoteMcpToolResult;

export interface SearchWebDetails {
	query: string;
	resultCount: number;
	urls: string[];
	/** Backend that produced this answer. */
	provider?: string;
	/** True when the answer came from a free provider instead of the paid tier. */
	degraded?: boolean;
}

export type SearchWebInvoker = (input: SearchWebInvocation) => Promise<SearchWebMcpResult>;

/** Resolve a full Streamable HTTP endpoint from an origin or endpoint override. */
export function resolveSearchWebServerUrl(
	configured: string | undefined,
	env: Record<string, string | undefined> = process.env,
	profile?: string,
): string {
	const profileDefault = resolveProfileSearchWebUrl(profile);
	const value =
		normalizeOptionalText(configured) ?? normalizeOptionalText(env.STEPCODE_SEARCH_WEB_MCP_URL) ?? profileDefault;

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return value;
	}

	if (parsed.pathname && parsed.pathname !== "/") return value.replace(/\/+$/u, "");
	// An override that carries only an origin still has to be billed to the
	// account the login belongs to, so it inherits the profile's own path. A
	// hardcoded `/v1` path here would send a plan login's searches to the
	// platform account whenever someone redirected the host alone.
	return `${parsed.origin}${new URL(profileDefault).pathname}`;
}

function resolveProfileSearchWebUrl(profile: string | undefined): string {
	if (profile && Object.hasOwn(SEARCH_WEB_PROFILE_URLS, profile)) {
		return SEARCH_WEB_PROFILE_URLS[profile as StepLoginProfileId];
	}
	return SEARCH_WEB_DEFAULT_URL;
}

/** Resolve search credentials without ever returning a placeholder value. */
export function resolveSearchWebApiKey(options: SearchWebToolOptions = {}): string | undefined {
	const env = options.env ?? process.env;
	const explicit = normalizeCredential(options.apiKey);
	if (explicit) return explicit;

	// `STEP_API_KEY` is deliberately absent. StepCode injects it together with
	// `STEP_BASE_URL` to reach its own model gateway, but the search endpoint is fixed
	// to the login profile and never follows that base URL, so honouring it here would
	// send a gateway key to api.stepfun.com and fail authentication. An explicit
	// `step --api-key` still arrives through `options.apiKey` above.
	const envKey = normalizeCredential(env.STEPCODE_SEARCH_API_KEY);
	if (envKey) return envKey;

	const authPath =
		normalizeOptionalText(options.authPath) ??
		normalizeOptionalText(env.STEPCODE_AUTH_PATH) ??
		join(resolveStepAgentDir(env), "auth.json");
	return readCredentialToken(readStoredCredential(STEP_PROVIDER_ID, authPath));
}

export function buildSearchWebDescription(): string {
	return [
		"Search the web when the answer depends on current or external information: recent news, fresh documentation, live data, or anything outside built-in knowledge.",
		"The tool returns compact structured results with markdown links.",
		"If this tool informs the answer, end the response with a Sources: section containing the relevant result URLs as markdown links.",
	].join("\n\n");
}

/**
 * Resolve the configured backend.
 *
 * Selection is re-read on every call, so a configuration edit applies to the
 * next search instead of requiring a new session.
 *
 * Supported values are `auto`, `off`, `step` and the five free provider ids. Any
 * other value is treated as `auto`: the setting only ever names a preferred
 * backend, so an unrecognized name (an older config, a provider that was
 * removed) degrades to the default chain rather than disabling search.
 */
export function resolveSearchChainMode(
	options: SearchWebToolOptions = {},
	env: Record<string, string | undefined> = options.env ?? process.env,
): SearchChainMode {
	const explicit = normalizeOptionalText(options.provider);
	const fromEnv = normalizeOptionalText(env[SEARCH_PROVIDER_ENV]);
	const fromConfig = readConfiguredProvider(env);
	const requested = explicit ?? fromEnv ?? fromConfig;
	if (!requested) return "auto";
	return (SEARCH_CHAIN_MODES as readonly string[]).includes(requested) ? (requested as SearchChainMode) : "auto";
}

function readConfiguredProvider(env: Record<string, string | undefined>): string | undefined {
	const path = resolveStepConfigPath(env);
	if (!existsSync(path)) return undefined;
	// A missing file contributes no setting; an unreadable or malformed one is a
	// real configuration error and must not be reported as "no preference".
	const document = readStepConfig(path);
	return normalizeOptionalText(document.search?.provider);
}

/** Create the Step-facing tool backed by the ordered search candidate chain. */
export function createSearchWebTool(
	options: SearchWebToolOptions = {},
	invokeTool: SearchWebInvoker = invokeRemoteMcpTool,
): ToolDefinition<typeof searchWebSchema, SearchWebDetails> {
	const env = options.env ?? process.env;

	return {
		name: "search_web",
		label: "search_web",
		description: buildSearchWebDescription(),
		promptSnippet: "Search the web for current or external information",
		promptGuidelines: ["Use search_web for current facts and cite relevant URLs in a final Sources: section."],
		parameters: searchWebSchema,
		executionMode: "parallel",
		execute: async (_toolCallId, args: SearchWebInput, signal, _onUpdate, _ctx: ExtensionContext) => {
			const query = args.query.trim();
			if (!query) throw new Error("search_web query must not be empty");

			// Backend, credential and endpoint are resolved per call. A login or a
			// configuration edit that happens during the session must be usable
			// without restarting it, and a bad value must fail this call rather
			// than the session that never used search.
			const mode = resolveSearchChainMode(options, env);
			const authPath = resolveSearchWebAuthPath(options, env);
			const apiKey = resolveSearchWebApiKey(options);
			const stepEndpoint = resolveSearchWebServerUrl(options.url, env, readStepLoginProfile(authPath));

			const chain = buildSearchChain({
				mode,
				hasStepCredential: Boolean(apiKey),
				stepEndpoint,
				...(options.random ? { random: options.random } : {}),
			});

			if (chain.requiresCredential) {
				// Pinned to the paid backend without a credential: a real
				// configuration error, not a reason to silently use a free provider.
				throw new Error(
					"search_web requires a credential; run `/login` or `step login`, pass --api-key, or set STEPCODE_SEARCH_API_KEY",
				);
			}

			const result = await runSearchChain({
				chain,
				query,
				...(signal ? { signal } : {}),
				invoke: (candidate, searchQuery, attemptOptions) => {
					if (candidate.tier === "stepfun") {
						return invokeStepFun({
							invokeTool,
							apiKey: apiKey ?? "",
							candidate,
							query: searchQuery,
							timeoutMs: attemptOptions.timeoutMs,
							signal: attemptOptions.signal,
						});
					}
					const adapter = findAdapter(candidate.id);
					if (!adapter) {
						return Promise.resolve({
							ok: false as const,
							failure: { kind: "unknown" as const, detail: `unknown provider ${candidate.id}` },
						});
					}
					return callSearchProvider({
						request: adapter.buildRequest(searchQuery),
						parse: adapter.parse,
						timeoutMs: attemptOptions.timeoutMs,
						allowHandshake: candidate.allowHandshake,
						serverName: candidate.id,
						...(attemptOptions.signal ? { signal: attemptOptions.signal } : {}),
					});
				},
			});

			return renderSearchResults(query, result);
		},
	};
}

async function invokeStepFun(input: {
	invokeTool: SearchWebInvoker;
	apiKey: string;
	candidate: { endpoint: string; toolName: string };
	query: string;
	/** One attempt's slice of the shared budget; without it a hanging endpoint blocks the whole chain. */
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<SearchAttempt> {
	const { invokeTool, apiKey, candidate, query, timeoutMs, signal } = input;
	try {
		const result = await invokeTool({
			serverName: SEARCH_WEB_SERVER_NAME,
			serverUrl: candidate.endpoint,
			toolName: SEARCH_WEB_TOOL_NAME,
			arguments: { query, n: SEARCH_WEB_RESULT_COUNT },
			headers: { Authorization: `Bearer ${apiKey}` },
			timeoutMs,
			...(signal ? { signal } : {}),
		});
		if (result.isError) {
			const detail = result.content || `MCP tool ${SEARCH_WEB_SERVER_NAME}.${SEARCH_WEB_TOOL_NAME} failed`;
			return {
				ok: false,
				failure: nameEndpoint(classifyFailure({ text: detail, isError: true }), candidate.endpoint),
			};
		}
		return { ok: true, outcome: readStepFunOutcome(result) };
	} catch (error) {
		// The message carries no credential; it is surfaced verbatim so a
		// profile/endpoint mismatch stays diagnosable, and cancellation is read
		// from the signal rather than from the message.
		return {
			ok: false,
			failure: nameEndpoint(
				classifyFailure({
					text: error instanceof Error ? error.message : String(error),
					cancelled: signal?.aborted === true,
				}),
				candidate.endpoint,
			),
		};
	}
}

/**
 * A search failure names the endpoint that produced it: for the paid tier the
 * endpoint decides which account is billed, so a profile/endpoint mismatch is
 * otherwise invisible until it shows up on a bill.
 */
function nameEndpoint(failure: SearchFailure, endpoint: string): SearchFailure {
	return { ...failure, detail: `${failure.detail} (endpoint ${endpoint})` };
}

/** Read the StepFun payload without changing its existing rendering semantics. */
function readStepFunOutcome(result: SearchWebMcpResult): SearchOutcome {
	const items = result.structuredContent?.results;
	if (!Array.isArray(items)) {
		const text = result.content?.trim();
		return text ? { hits: [], text } : { hits: [] };
	}
	const hits: SearchHit[] = [];
	for (const item of items) {
		const record = isRecord(item) ? item : {};
		const url = normalizeOptionalText(record.url);
		if (!url) continue;
		const title = normalizeOptionalText(record.title);
		const snippet = shortenText(
			normalizeOptionalText(record.snippet) ?? normalizeOptionalText(record.content) ?? "",
			MAX_SNIPPET_CHARS,
		);
		hits.push({
			url,
			...(title ? { title } : {}),
			...(snippet ? { snippet } : {}),
		});
		if (hits.length >= SEARCH_WEB_RESULT_COUNT) break;
	}
	return { hits };
}

function resolveSearchWebAuthPath(options: SearchWebToolOptions, env: Record<string, string | undefined>): string {
	return (
		normalizeOptionalText(options.authPath) ??
		normalizeOptionalText(env.STEPCODE_AUTH_PATH) ??
		join(resolveStepAgentDir(env), "auth.json")
	);
}

function renderSearchResults(query: string, result: SearchChainResult): AgentToolResult<SearchWebDetails> {
	const details: SearchWebDetails = {
		query,
		resultCount: result.outcome.hits.length,
		urls: result.outcome.hits.flatMap((hit) => (hit.url ? [hit.url] : [])),
		provider: result.provider,
		degraded: result.degraded,
	};

	if (result.outcome.hits.length === 0) {
		const text = result.outcome.text?.trim() || `No search results for "${query}".`;
		return { content: [{ type: "text", text }], details };
	}

	const content = result.outcome.hits
		.map((hit, index) => {
			const heading = `${index + 1}. [${hit.title ?? hit.url}](${hit.url})`;
			return hit.snippet ? `${heading}\n   ${shortenText(hit.snippet, MAX_SNIPPET_CHARS)}` : heading;
		})
		.join("\n\n");

	return { content: [{ type: "text", text: content }], details };
}

function readCredentialToken(credential: Credential | undefined): string | undefined {
	if (!credential || typeof credential !== "object") return undefined;
	const record = credential as unknown as Record<string, unknown>;
	return normalizeCredential(record.access) ?? normalizeCredential(record.key);
}

function normalizeCredential(value: unknown): string | undefined {
	const normalized = normalizeOptionalText(value);
	return normalized && normalized !== "<your_api_key>" ? normalized : undefined;
}

function normalizeOptionalText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shortenText(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
