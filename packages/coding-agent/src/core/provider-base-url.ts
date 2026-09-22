/** Normalization for provider base URLs supplied by user configuration. */

import type { Api } from "@step-harness/providers";

/**
 * Operation path each adapter appends to the configured base URL.  Only APIs
 * with a single, unambiguous operation path are listed; anything else is left
 * untouched because the suffix cannot be identified safely.
 */
const OPERATION_SUFFIXES: Partial<Record<Api, string>> = {
	"anthropic-messages": "/messages",
	"openai-completions": "/chat/completions",
	"openai-responses": "/responses",
};

/**
 * Turn a configured base URL into the API root the adapter expects.
 *
 * Adapters append their own operation path, so a configuration that already
 * spells one out sends the request to a doubled path.  The Anthropic SDK
 * additionally appends the version segment (`/v1/messages`), which makes a
 * configured `/v1` root produce `/v1/v1/messages` and a bare
 * `404 page not found` from the proxy.  OpenAI shaped SDKs append only the
 * operation segment, so their `/v1` root must be preserved.
 *
 * Only a trailing segment is removed; arbitrary proxy paths such as
 * `https://gateway.example.com/v1/<account>/anthropic` stay intact.
 */
export function normalizeProviderBaseUrl(value: string | undefined, api: Api | undefined): string | undefined {
	if (!value || !api) return value;
	const suffix = OPERATION_SUFFIXES[api];
	if (!suffix) return value;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		// Keep malformed URLs intact; provider validation reports the actionable
		// error when the model is selected.
		return value;
	}
	let pathname = url.pathname.replace(/\/+$/u, "");
	if (pathname.toLowerCase().endsWith(suffix)) pathname = pathname.slice(0, -suffix.length).replace(/\/+$/u, "");
	if (api === "anthropic-messages" && pathname.toLowerCase().endsWith("/v1")) {
		pathname = pathname.slice(0, -"/v1".length).replace(/\/+$/u, "");
	}
	url.pathname = pathname || "/";
	return url.toString().replace(/\/+$/u, "");
}
