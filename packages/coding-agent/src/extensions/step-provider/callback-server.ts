import { createServer, type Server, type ServerResponse } from "node:http";

/** Callback route used by the Step developer-center login page. */
export const STEP_OAUTH_CALLBACK_PATH = "/callback";

/** Optional route that lets a browser cancel a pending login. */
export const STEP_OAUTH_CANCEL_PATH = "/cancel";

/** Ten minutes is long enough for a user to finish a browser login. */
export const DEFAULT_STEP_OAUTH_TIMEOUT_MS = 10 * 60 * 1000;

export const STEP_OAUTH_ERROR_CODES = ["no_access_key", "access_denied", "bad_request", "server_error"] as const;

export type StepOAuthErrorCode = (typeof STEP_OAUTH_ERROR_CODES)[number];

export type StepCallbackResult =
	| {
			readonly kind: "credential";
			readonly apiKey: string;
			readonly uid?: string;
			readonly refreshToken?: string;
			readonly expiresInSeconds?: number;
	  }
	| { readonly kind: "code"; readonly code: string }
	| { readonly kind: "error"; readonly code: StepOAuthErrorCode | "unknown"; readonly description?: string }
	| { readonly kind: "cancelled" }
	| { readonly kind: "timeout" };

export interface StepCallbackServer {
	/** Port selected by the operating system (or the requested fixed port). */
	readonly port: number;
	/** Resolves once, on the first valid callback, cancellation, or timeout. */
	waitForResult(): Promise<StepCallbackResult>;
	/** Idempotent cleanup. Safe while `waitForResult()` is pending. */
	close(): Promise<void>;
}

export interface StartStepCallbackServerOptions {
	/** State generated for this login; callbacks must echo it exactly. */
	readonly state: string;
	/** Loopback host. Defaults to `127.0.0.1`. */
	readonly host?: string;
	/** `0` asks the OS for an available port. */
	readonly port?: number;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	/** Injected clocks make timeout behavior deterministic in tests. */
	readonly setTimeoutFn?: SetTimeoutFn;
	readonly clearTimeoutFn?: ClearTimeoutFn;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimeoutFn = (callback: () => void, delay: number) => TimerHandle;
type ClearTimeoutFn = (timer: TimerHandle) => void;

/**
 * Start a loopback callback server for the Step browser login.
 *
 * The server accepts only the expected state. Invalid-state requests receive a
 * response but cannot settle the login promise, so a stray request can never
 * authenticate a different login attempt.
 */
export async function startStepCallbackServer(options: StartStepCallbackServerOptions): Promise<StepCallbackServer> {
	assertState(options.state);
	const host = options.host ?? "127.0.0.1";
	assertLoopbackHost(host);
	const port = options.port ?? 0;
	assertPort(port);

	const setTimeoutFn = options.setTimeoutFn ?? ((callback, delay) => setTimeout(callback, delay));
	const clearTimeoutFn = options.clearTimeoutFn ?? ((timer) => clearTimeout(timer));

	let settle: ((result: StepCallbackResult) => void) | undefined;
	let settled = false;
	const resultPromise = new Promise<StepCallbackResult>((resolve) => {
		settle = resolve;
	});
	const finish = (result: StepCallbackResult): void => {
		if (settled) return;
		settled = true;
		settle?.(result);
	};

	const onAbort = (): void => finish({ kind: "cancelled" });
	if (options.signal?.aborted) {
		finish({ kind: "cancelled" });
	} else {
		options.signal?.addEventListener("abort", onAbort, { once: true });
	}

	const server = createServer((request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname === STEP_OAUTH_CANCEL_PATH) {
				respondText(response, 200, "Sign-in cancelled. You can close this tab.");
				finish({ kind: "cancelled" });
				return;
			}

			if (url.pathname !== STEP_OAUTH_CALLBACK_PATH) {
				respondText(response, 404, "Not found.");
				return;
			}

			if (url.searchParams.get("state") !== options.state) {
				respondText(response, 400, "This sign-in link is no longer valid.");
				return;
			}

			const error = readNonEmpty(url.searchParams.get("error"));
			if (error) {
				respondText(response, 400, "Sign-in did not complete. Return to your terminal.");
				finish({
					kind: "error",
					code: isStepOAuthErrorCode(error) ? error : "unknown",
					description: readNonEmpty(url.searchParams.get("error_description")),
				});
				return;
			}

			const apiKey = firstNonEmpty(url.searchParams, ["api_key", "apiKey"]);
			const accessToken = firstNonEmpty(url.searchParams, ["access_token", "accessToken"]);
			if (apiKey || accessToken) {
				respondText(response, 200, "Sign-in complete. You can close this tab.");
				const uid = readBoundedUid(url.searchParams.get("uid"));
				const refreshToken = firstNonEmpty(url.searchParams, ["refresh_token", "refreshToken"]);
				const expiresInSeconds = readPositiveNumber(firstNonEmpty(url.searchParams, ["expires_in", "expiresIn"]));
				finish({
					kind: "credential",
					apiKey: apiKey ?? accessToken!,
					...(uid ? { uid } : undefined),
					...(refreshToken ? { refreshToken } : undefined),
					...(expiresInSeconds ? { expiresInSeconds } : undefined),
				});
				return;
			}

			const code = firstNonEmpty(url.searchParams, ["code"]);
			if (code) {
				respondText(response, 200, "Sign-in callback received. You can close this tab.");
				finish({ kind: "code", code });
				return;
			}

			respondText(response, 400, "Missing sign-in result.");
			finish({ kind: "error", code: "unknown", description: "The callback did not contain a credential." });
		} catch {
			respondText(response, 500, "Sign-in callback failed.");
		}
	});

	let timer: TimerHandle | undefined;
	let closed: Promise<void> | undefined;
	const removeAbortListener = (): void => options.signal?.removeEventListener("abort", onAbort);

	try {
		await listen(server, host, port);
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Unable to determine the Step OAuth callback port");
		}

		timer = setTimeoutFn(() => finish({ kind: "timeout" }), options.timeoutMs ?? DEFAULT_STEP_OAUTH_TIMEOUT_MS);
		unrefTimer(timer);

		const close = async (): Promise<void> => {
			if (!closed) {
				clearTimeoutFn(timer!);
				removeAbortListener();
				finish({ kind: "cancelled" });
				closed = closeServer(server);
			}
			await closed;
		};

		return {
			port: address.port,
			waitForResult: async () => {
				try {
					return await resultPromise;
				} finally {
					if (timer) clearTimeoutFn(timer);
					removeAbortListener();
				}
			},
			close,
		};
	} catch (error) {
		removeAbortListener();
		if (timer) clearTimeoutFn(timer);
		await closeServer(server);
		throw error;
	}
}

/** Build the developer-center URL that starts a Step login. */
export function buildStepAuthorizationUrl(input: {
	readonly authBaseUrl: string;
	readonly port: number;
	readonly state: string;
	readonly path?: string;
}): string {
	assertState(input.state);
	assertPort(input.port);
	const base = parseHttpUrl(input.authBaseUrl, "Step OAuth authorization endpoint");
	const path = input.path ?? "/cli-login";
	if (!path.startsWith("/")) throw new Error("Step OAuth authorization path must start with '/'");
	const url = new URL(path, `${base.origin}/`);
	url.searchParams.set("port", String(input.port));
	url.searchParams.set("state", input.state);
	return url.toString();
}

/** Build the redirect URI represented by a callback server. */
export function buildStepCallbackUrl(input: {
	readonly host?: string;
	readonly port: number;
	readonly path?: string;
}): string {
	const host = input.host ?? "127.0.0.1";
	assertLoopbackHost(host);
	assertPort(input.port);
	const path = input.path ?? STEP_OAUTH_CALLBACK_PATH;
	if (!path.startsWith("/")) throw new Error("Step OAuth callback path must start with '/'");
	return `http://${formatHost(host)}:${input.port}${path}`;
}

function listen(server: Server, host: string, port: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise<void>((resolve) => {
		if (!server.listening) {
			resolve();
			return;
		}
		server.close(() => resolve());
		server.closeAllConnections?.();
	});
}

function respondText(response: ServerResponse, status: number, body: string): void {
	if (response.headersSent) return;
	response.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(`${body}\n`);
}

function firstNonEmpty(params: URLSearchParams, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = readNonEmpty(params.get(name));
		if (value) return value;
	}
	return undefined;
}

function readNonEmpty(value: string | null): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function readPositiveNumber(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readBoundedUid(value: string | null): string | undefined {
	const trimmed = readNonEmpty(value);
	if (!trimmed || trimmed.length > 64 || !/^[\w.@:-]+$/u.test(trimmed)) return undefined;
	return trimmed;
}

function isStepOAuthErrorCode(value: string): value is StepOAuthErrorCode {
	return (STEP_OAUTH_ERROR_CODES as readonly string[]).includes(value);
}

function parseHttpUrl(value: string, label: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} must be a valid URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${label} must use http or https`);
	}
	if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
	return url;
}

function assertState(state: string): void {
	if (!state.trim()) throw new Error("Step OAuth state must not be empty");
}

function assertPort(port: number): void {
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error("Step OAuth callback port must be an integer between 0 and 65535");
	}
}

function assertLoopbackHost(host: string): void {
	if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
		throw new Error("Step OAuth callback host must be loopback");
	}
}

function formatHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}

function unrefTimer(timer: TimerHandle): void {
	if (typeof timer === "object" && timer !== null && "unref" in timer) {
		(timer as { unref?: () => void }).unref?.();
	}
}
