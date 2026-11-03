import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { openBrowser } from "../utils/open-browser.ts";
import { resolveStepConfigRoot } from "./environment.ts";

/** How long `step mcp login` waits for the browser to come back. */
const OAUTH_CALLBACK_TIMEOUT_SEC = 300;

/** Path the loopback listener accepts; anything else is not our callback. */
const OAUTH_CALLBACK_PATH = "/callback";

interface StoredCredential {
	serverName: string;
	serverUrl: string;
	clientInformation?: OAuthClientInformationMixed;
	tokens: OAuthTokens;
}
interface CredentialStore {
	[key: string]: StoredCredential;
}

/** Create a non-interactive provider that reuses and refreshes saved MCP tokens. */
export function createStoredMcpOAuthProvider(
	name: string,
	serverUrl: string,
	env: NodeJS.ProcessEnv = process.env,
): {
	readonly redirectUrl: undefined;
	readonly clientMetadata: OAuthClientMetadata;
	clientInformation(): OAuthClientInformationMixed | undefined;
	tokens(): OAuthTokens | undefined;
	saveClientInformation(value: OAuthClientInformationMixed): void;
	saveTokens(value: OAuthTokens): void;
	redirectToAuthorization(): never;
	saveCodeVerifier(value: string): void;
	codeVerifier(): string;
} {
	const entry = loadStore(env)[key(name, serverUrl)];
	let clientInformation = entry?.clientInformation;
	let codeVerifier = "";
	return {
		redirectUrl: undefined,
		clientMetadata: {
			client_name: "StepCode",
			redirect_uris: [],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		},
		clientInformation: () => clientInformation,
		tokens: () => loadStore(env)[key(name, serverUrl)]?.tokens,
		saveClientInformation: (value) => {
			clientInformation = value;
		},
		saveTokens: (tokens) => {
			const store = loadStore(env);
			store[key(name, serverUrl)] = { serverName: name, serverUrl, clientInformation, tokens };
			saveStore(env, store);
		},
		redirectToAuthorization: () => {
			throw new Error(`MCP server '${name}' requires login; run step mcp login ${name}`);
		},
		saveCodeVerifier: (value) => {
			codeVerifier = value;
		},
		codeVerifier: () => codeVerifier,
	};
}

export function hasStoredMcpOAuthCredential(
	name: string,
	serverUrl: string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return Boolean(loadStore(env)[key(name, serverUrl)]?.tokens?.access_token);
}

function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
	// Beside `config.toml`, `auth.json` and `models.json`. Recomputing this from
	// the home directory would strand credentials in a second location whenever a
	// host injects STEP_CODING_AGENT_DIR.
	return join(resolveStepConfigRoot(env), ".credentials.json");
}

function key(name: string, url: string): string {
	return `${name}|${url}`;
}

function loadStore(env: NodeJS.ProcessEnv): CredentialStore {
	const path = credentialsPath(env);
	if (!existsSync(path)) return {};
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as CredentialStore) : {};
}

function saveStore(env: NodeJS.ProcessEnv, store: CredentialStore): void {
	const path = credentialsPath(env);
	mkdirSync(resolveStepConfigRoot(env), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

export async function loginMcpServer(
	name: string,
	serverUrl: string,
	oauthConfig: { client_id?: string; client_secret?: string; scopes?: string[]; callback_port?: number } = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	let resolveCode: (code: string) => void = () => undefined;
	let rejectCode: (error: Error) => void = () => undefined;
	const code = new Promise<string>((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});
	// The flow can fail before anything awaits `code`. Keep a handler attached so
	// a late rejection cannot crash the CLI as an unhandled rejection.
	void code.catch(() => undefined);
	// The authorization server echoes this back. Comparing it rejects a callback
	// that some other page in the user's browser aimed at our loopback port.
	const state = randomBytes(32).toString("base64url");
	const callback = createServer((request, response) => {
		const outcome = resolveOAuthCallback(new URL(request.url ?? "/", "http://127.0.0.1"), state, {
			resolve: resolveCode,
			reject: rejectCode,
		});
		if (outcome.status === 200) response.writeHead(200, { "content-type": "text/html" });
		else response.writeHead(outcome.status);
		response.end(outcome.body);
	});
	// A declared port is not a preference: providers that only accept a
	// pre-registered redirect URI reject anything else, so a taken port has to
	// surface as an error rather than silently move the listener elsewhere.
	const port = oauthConfig.callback_port ?? 0;
	try {
		await new Promise<void>((resolve, reject) => {
			callback.once("error", reject);
			callback.listen(port, "127.0.0.1", () => {
				callback.removeListener("error", reject);
				resolve();
			});
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			port === 0
				? `Could not open an OAuth callback port: ${detail}`
				: `Could not open OAuth callback port ${port} for '${name}': ${detail}`,
		);
	}
	const address = callback.address();
	if (!address || typeof address === "string") throw new Error("Could not allocate OAuth callback port");
	const redirectUrl = `http://127.0.0.1:${address.port}${OAUTH_CALLBACK_PATH}`;
	let codeVerifier = "";
	let clientInformation: OAuthClientInformationMixed | undefined =
		loadStore(env)[key(name, serverUrl)]?.clientInformation;
	if (oauthConfig.client_id) {
		clientInformation = {
			client_id: oauthConfig.client_id,
			...(oauthConfig.client_secret ? { client_secret: oauthConfig.client_secret } : {}),
		};
	}
	const metadata = buildOAuthClientMetadata(redirectUrl, oauthConfig);
	// The same string the client registered with. Deriving both from one helper
	// keeps the registration and the authorization request from drifting apart.
	const scope = metadata.scope;
	const provider = {
		redirectUrl: redirectUrl,
		clientMetadata: metadata,
		clientInformation: () => clientInformation,
		saveClientInformation: (value: OAuthClientInformationMixed) => {
			clientInformation = value;
		},
		state: () => state,
		tokens: () => loadStore(env)[key(name, serverUrl)]?.tokens,
		saveTokens: (tokens: OAuthTokens) => {
			const store = loadStore(env);
			store[key(name, serverUrl)] = { serverName: name, serverUrl, clientInformation, tokens };
			saveStore(env, store);
		},
		redirectToAuthorization: (url: URL) => {
			process.stderr.write(`Open this URL to authorize ${name}:\n${url}\n`);
			void openBrowser(url.toString());
		},
		saveCodeVerifier: (value: string) => {
			codeVerifier = value;
		},
		codeVerifier: () => codeVerifier,
	};
	// Never park the CLI on a browser tab the user closed, and let Ctrl-C out of
	// the wait instead of leaving the listener holding the event loop open.
	const timer = setTimeout(
		() => rejectCode(new Error(`Timed out after ${OAUTH_CALLBACK_TIMEOUT_SEC}s waiting for OAuth authorization.`)),
		OAUTH_CALLBACK_TIMEOUT_SEC * 1_000,
	);
	const onInterrupt = () => rejectCode(new Error(`Authorization for '${name}' was canceled.`));
	process.once("SIGINT", onInterrupt);
	const onServerError = (error: Error) => rejectCode(error);
	callback.on("error", onServerError);
	try {
		// Let the SDK derive the RFC 9728 metadata URL. Passing one built here
		// would drop the resource path (`https://host/mcp`) and, because an
		// explicit URL disables the SDK's path-aware discovery and root fallback,
		// break every server that publishes the path-suffixed document.
		const result = await auth(provider, { serverUrl, ...(scope ? { scope } : {}) });
		if (result === "REDIRECT")
			await auth(provider, { serverUrl, ...(scope ? { scope } : {}), authorizationCode: await code });
		process.stdout.write(`Authenticated MCP server '${name}'.\n`);
	} finally {
		clearTimeout(timer);
		process.removeListener("SIGINT", onInterrupt);
		callback.removeListener("error", onServerError);
		await new Promise<void>((resolve) => callback.close(() => resolve()));
	}
}

/**
 * Build the metadata a dynamically registered client presents.
 *
 * Exported so the scope string that reaches both registration and the
 * authorization request can be asserted without standing up a provider.
 */
export function buildOAuthClientMetadata(
	redirectUrl: string,
	oauthConfig: { client_secret?: string; scopes?: string[] },
): OAuthClientMetadata {
	const scope = oauthConfig.scopes?.filter((entry) => entry.trim()).join(" ") || undefined;
	return {
		client_name: "StepCode",
		redirect_uris: [redirectUrl],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: oauthConfig.client_secret ? "client_secret_post" : "none",
		// Declared at registration as well as on the request: a dynamically
		// registered client that never asked for these scopes is refused them.
		...(scope ? { scope } : {}),
	};
}

/**
 * Decide how to answer one loopback callback request.
 *
 * Split out from the listener so the two security checks — our path only, and
 * a state matching the one we generated — are testable without a browser.
 */
export function resolveOAuthCallback(
	url: URL,
	state: string,
	sink: { resolve(code: string): void; reject(error: Error): void },
): { status: number; body: string } {
	if (url.pathname !== OAUTH_CALLBACK_PATH) return { status: 404, body: "Not found" };
	if (!matchesState(url.searchParams.get("state"), state)) return { status: 400, body: "Invalid OAuth state" };
	const error = url.searchParams.get("error");
	if (error) {
		sink.reject(new Error(`OAuth authorization failed: ${error}`));
		return { status: 400, body: "Authorization failed" };
	}
	const authorizationCode = url.searchParams.get("code");
	if (!authorizationCode) return { status: 400, body: "Missing authorization code" };
	sink.resolve(authorizationCode);
	return { status: 200, body: "Authentication complete. You may close this window." };
}

/** Compare the echoed OAuth state without leaking its length through timing. */
function matchesState(received: string | null, expected: string): boolean {
	if (received === null) return false;
	const a = Buffer.from(received);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function logoutMcpServer(name: string, serverUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const store = loadStore(env);
	const entry = key(name, serverUrl);
	if (!store[entry]) return false;
	delete store[entry];
	saveStore(env, store);
	return true;
}
