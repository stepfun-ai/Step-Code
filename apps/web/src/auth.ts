import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Where the cookie-signing secret lives between runs.
 *
 * A per-process random secret invalidates every issued cookie the moment the
 * server restarts, which silently logs the browser out mid-session. Persisting
 * it keeps a restart from looking like a lost login. The file sits beside
 * auth.json in the StepCode config root, so it inherits the same 0600
 * protection and the same trust boundary: anything that can read it can already
 * read the model credentials.
 *
 * The filename itself is chosen by the server, which owns where the config root
 * is; this module only reads and writes the path it is handed.
 */

function loadOrCreateSecret(path: string): Buffer {
	try {
		const existing = readFileSync(path, "utf8").trim();
		if (existing) return Buffer.from(existing, "base64url");
	} catch {
		// Missing or unreadable: fall through and mint a new one.
	}
	const secret = randomBytes(32);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, secret.toString("base64url"), { mode: 0o600 });
	} catch {
		// A read-only config root must not stop the server from starting; the
		// secret simply stays in memory for this run.
	}
	return secret;
}

export class WebAuth {
	private readonly secret: Buffer;
	private readonly launchToken = randomBytes(24).toString("base64url");
	private launchTokenUsed = false;
	private readonly allowedOrigins: readonly string[];

	constructor(allowedOrigins: readonly string[], secretPath?: string) {
		this.allowedOrigins = allowedOrigins;
		this.secret = secretPath ? loadOrCreateSecret(secretPath) : randomBytes(32);
	}

	getLaunchToken(): string {
		return this.launchToken;
	}

	exchange(token: unknown, origin: string | undefined): string | undefined {
		if (!this.isAllowedOrigin(origin) || this.launchTokenUsed || token !== this.launchToken) return undefined;
		this.launchTokenUsed = true;
		return this.cookieValue(randomBytes(16).toString("hex"));
	}

	/**
	 * `fetchSite` is the request's `Sec-Fetch-Site`. Pages on another loopback
	 * port (a rendered workspace preview, any local dev server) are same-site with
	 * the Host, so SameSite=Strict still sends the cookie on their navigations and
	 * subresource loads, which carry no Origin. Only the client's own page
	 * (`same-origin`), a typed or opened URL (`none`) or a client that sends no
	 * fetch metadata is accepted.
	 */
	authorize(cookie: string | undefined, origin: string | undefined, fetchSite?: string): boolean {
		if (fetchSite === "same-site" || fetchSite === "cross-site") return false;
		if (!this.isAllowedOrigin(origin) || !cookie) return false;
		const [payload, signature] = cookie.split(".");
		if (!payload || !signature) return false;
		const expected = this.sign(payload);
		try {
			return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
		} catch {
			return false;
		}
	}

	allowsOrigin(origin: string | undefined): boolean {
		return this.isAllowedOrigin(origin);
	}

	private isAllowedOrigin(origin: string | undefined): boolean {
		return !origin || this.allowedOrigins.includes(origin);
	}

	private sign(value: string): string {
		return createHmac("sha256", this.secret).update(value).digest("base64url");
	}

	private cookieValue(value: string): string {
		return `${value}.${this.sign(value)}`;
	}
}
