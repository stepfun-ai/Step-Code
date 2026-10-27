/**
 * Window origin and permission policy.
 *
 * The renderer is the StepCode web client served by the local host, so the
 * window only ever grants a fixed permission list to that one origin. Everything
 * else — any other origin, any other permission — gets Electron's default denial.
 *
 * `clipboard-read` is deliberately absent: the client never calls
 * `navigator.clipboard.readText()`. Terminal pasting uses the browser's native
 * paste event (menu role / Cmd+V), whose clipboard data arrives with the event
 * and needs no permission. Only the clipboard *write* used by copy actions is
 * granted.
 */

/** Permissions the web client uses on its own origin. */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
	/** `navigator.clipboard.writeText` for the client's copy actions. */
	"clipboard-sanitized-write",
	"fullscreen",
	/**
	 * The composer's microphone button records through getUserMedia, which
	 * Electron denies by default. macOS still shows its own TCC prompt the first
	 * time; that is expected and the client's error text says so.
	 */
	"media",
]);

/** The `URL.origin` of `url`, or undefined when it cannot be parsed. */
export function originOf(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

/** Whether a page may use `permission`: fixed list, own server origin only, and only once that origin exists. */
export function isAllowedPermission(
	permission: string,
	requestingUrl: string,
	serverOrigin: string | undefined,
): boolean {
	if (serverOrigin === undefined || !ALLOWED_PERMISSIONS.has(permission)) return false;
	return originOf(requestingUrl) === serverOrigin;
}
