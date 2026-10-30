/**
 * JSON fetch wrapper for the StepCode Web host API (legacy app.js `api()`).
 *
 * Every request carries `content-type: application/json`; a non-2xx response
 * throws an ApiError whose message is the server's `error` field (or `HTTP <n>`).
 * A 401 additionally triggers the registered unauthorized handler, which the
 * session layer uses to show the "connection lost" banner: the launch token is
 * single-use, so a stale cookie is an expected state, not a bug.
 */

type UnauthorizedHandler = () => void;

/**
 * A non-2xx response; `body` is the parsed JSON error payload (`error` plus any extra fields).
 */
export class ApiError extends Error {
	readonly status: number;
	readonly body: Readonly<Record<string, unknown>>;

	constructor(status: number, body: Readonly<Record<string, unknown>>) {
		// Most routes answer `{ error }`, but a kernel rejection answers
		// `{ ok: false, message }` (feedback). Reading only `error` turned those
		// into a bare "HTTP 400" with no reason for the user.
		super(errorText(body) ?? `HTTP ${status}`);
		this.status = status;
		this.body = body;
	}
}

function errorText(body: Readonly<Record<string, unknown>>): string | undefined {
	if (typeof body.error === "string" && body.error.trim()) return body.error;
	if (typeof body.message === "string" && body.message.trim()) return body.message;
	return undefined;
}

let unauthorizedHandler: UnauthorizedHandler | undefined;

/** Register the callback run on every 401 response. Pass undefined to clear it. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | undefined): void {
	unauthorizedHandler = handler;
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
	const response = await fetch(path, {
		...options,
		headers: { "content-type": "application/json", ...((options.headers as Record<string, string>) ?? {}) },
	});
	if (response.status === 401) unauthorizedHandler?.();
	if (!response.ok) {
		const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		throw new ApiError(response.status, payload);
	}
	return (await response.json()) as T;
}

/** POST/PATCH/DELETE helper: `api(path, { method, body: JSON.stringify(body) })`. */
export function apiSend<T = unknown>(path: string, method: string, body?: unknown): Promise<T> {
	return api<T>(path, body === undefined ? { method } : { method, body: JSON.stringify(body) });
}

/** Build a workspace-scoped API URL; `cwd` selects the folder, not a session (legacy `workspaceApi`). */
export function workspaceApi(cwd: string, endpoint: string, params: Record<string, string> = {}): string {
	return `/api/v1/workspace${endpoint}?${new URLSearchParams({ cwd, ...params })}`;
}

/** URL of the outside-workspace file API; `path` is an absolute local path. */
export function localFileApi(endpoint: "" | "/raw", path: string): string {
	return `/api/v1/file${endpoint}?${new URLSearchParams({ path })}`;
}

/** Message of a caught value, as the legacy code read `error.message`. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
