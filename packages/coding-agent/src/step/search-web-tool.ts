import { join } from "node:path";
import type { AgentToolResult } from "@step-harness/agent-core";
import type { Credential } from "@step-harness/providers";
import { type Static, Type } from "typebox";
import { readStoredCredential } from "../core/auth-storage.ts";
import type { ExtensionContext, ToolDefinition } from "../core/extensions/types.ts";
import { STEP_PROVIDER_ID } from "../features/step-provider/index.ts";
import { resolveStepAgentDir } from "./environment.ts";
import { readStepLoginProfile } from "./login-flow.ts";
import { invokeRemoteMcpTool, type RemoteMcpToolInvocation, type RemoteMcpToolResult } from "./mcp-client.ts";
import type { StepLoginProfileId } from "./onboarding.ts";

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
}

export type SearchWebInvocation = RemoteMcpToolInvocation & {
	arguments: { query: string; n: number };
};

export type SearchWebMcpResult = RemoteMcpToolResult;

export interface SearchWebDetails {
	query: string;
	resultCount: number;
	urls: string[];
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

/** Create the Step-facing tool backed by the remote web-search MCP server. */
export function createSearchWebTool(
	options: SearchWebToolOptions = {},
	invokeTool: SearchWebInvoker = invokeRemoteMcpTool,
): ToolDefinition<typeof searchWebSchema, SearchWebDetails> {
	const env = options.env ?? process.env;
	const authPath = resolveSearchWebAuthPath(options, env);
	const serverUrl = resolveSearchWebServerUrl(options.url, env, readStepLoginProfile(authPath));
	const apiKey = resolveSearchWebApiKey(options);

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
			if (!apiKey) {
				throw new Error(
					"search_web requires a credential; run `/login` or `step login`, pass --api-key, or set STEPCODE_SEARCH_API_KEY",
				);
			}

			// The endpoint decides which account the search is billed to, so every
			// failure names it: a profile/endpoint mismatch is otherwise invisible
			// until it shows up on a bill. The URL carries no credential.
			let result: SearchWebMcpResult;
			try {
				result = await invokeTool({
					serverName: SEARCH_WEB_SERVER_NAME,
					serverUrl,
					toolName: SEARCH_WEB_TOOL_NAME,
					arguments: { query, n: SEARCH_WEB_RESULT_COUNT },
					headers: { Authorization: `Bearer ${apiKey}` },
					signal,
				});
			} catch (error) {
				throw new Error(`${error instanceof Error ? error.message : String(error)} (endpoint ${serverUrl})`);
			}
			if (result.isError) {
				const detail = result.content || `MCP tool ${SEARCH_WEB_SERVER_NAME}.${SEARCH_WEB_TOOL_NAME} failed`;
				throw new Error(`${detail} (endpoint ${serverUrl})`);
			}
			return renderSearchResults(query, result);
		},
	};
}

function resolveSearchWebAuthPath(options: SearchWebToolOptions, env: Record<string, string | undefined>): string {
	return (
		normalizeOptionalText(options.authPath) ??
		normalizeOptionalText(env.STEPCODE_AUTH_PATH) ??
		join(resolveStepAgentDir(env), "auth.json")
	);
}

function renderSearchResults(query: string, raw: SearchWebMcpResult): AgentToolResult<SearchWebDetails> {
	const items = raw.structuredContent?.results;
	if (!Array.isArray(items)) {
		const content = raw.content?.trim() || `No search results for "${query}".`;
		return {
			content: [{ type: "text", text: content }],
			details: { query, resultCount: 0, urls: [] },
		};
	}

	const results = items.map((item, index) => {
		const record = isRecord(item) ? item : {};
		const url = normalizeOptionalText(record.url);
		const title = normalizeOptionalText(record.title);
		const snippet = shortenText(
			normalizeOptionalText(record.snippet) ?? normalizeOptionalText(record.content) ?? "",
			MAX_SNIPPET_CHARS,
		);
		return {
			position: typeof record.position === "number" ? record.position : index + 1,
			title,
			url,
			snippet,
		};
	});

	const urls = results.flatMap((result) => (result.url ? [result.url] : []));
	const content = results.length
		? results
				.map((result) => {
					const heading = result.url
						? `${result.position}. [${result.title ?? result.url}](${result.url})`
						: `${result.position}. ${result.title ?? "(untitled)"}`;
					return result.snippet ? `${heading}\n   ${result.snippet}` : heading;
				})
				.join("\n\n")
		: `No search results for "${query}".`;

	return {
		content: [{ type: "text", text: content }],
		details: { query, resultCount: results.length, urls },
	};
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
