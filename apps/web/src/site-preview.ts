import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { extname, join, relative, sep } from "node:path";
import { containedWorkspacePath } from "./files.ts";

/**
 * Static serving of workspace files for rendered previews (a delivered
 * `index.html` with its CSS, scripts and images), shown in the embedded browser
 * or the system browser.
 *
 * It listens on its own loopback port, never the Host's: agent-written HTML must
 * not share the client's origin, where its scripts could call `/api` with the
 * page's cookie. The Host additionally refuses same-site requests, so a served
 * page cannot ride the cookie into the Host either (`server.ts`). The embedded
 * browser's port block covers only the Host ports, so this origin stays reachable.
 *
 * URLs name the host `localhost`, not `127.0.0.1` (the listener is still on
 * 127.0.0.1, where Chromium resolves `localhost`). The client is served from
 * 127.0.0.1, and a page on another port of the same host is same-site: in the
 * Web embedded browser's iframe it shared the client's renderer process and main
 * thread, so a busy animation dropped the conversation UI from 60 to ~25 fps.
 * `localhost` is a different site, so the frame gets its own process.
 *
 * Each workspace gets one unguessable token, minted on demand by an
 * authenticated Host route; the URL path is `/<token>/<workspace-relative path>`.
 * Without the token nothing is served. Only GET and HEAD, no directory listings,
 * and every path goes through the same containment check as the file preview,
 * so a symlink cannot leave the workspace.
 *
 * An earlier version of a file (what a past turn delivered, rebuilt by the
 * caller) is served from memory at the file's own URL plus `?rev=<id>`, so its
 * relative assets still resolve beside it; they load as they are on disk now.
 */

/** Workspaces with a live token. The oldest is forgotten beyond this bound. */
const MAX_SITES = 64;
/** Earlier versions of files held in memory; the oldest is forgotten beyond this bound. */
const MAX_VERSIONS = 32;
/** Largest earlier version held in memory, the file preview's own text limit. */
const MAX_VERSION_BYTES = 1_000_000;

const SITE_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".xhtml": "application/xhtml+xml; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".cjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".pdf": "application/pdf",
	".wasm": "application/wasm",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
	".flac": "audio/flac",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
};

/** The Content-Type a site file is served with; unknown types download as bytes. */
export function siteContentType(path: string): string {
	return SITE_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Split a request path into its token and workspace-relative segments, or
 * undefined for anything malformed. Segments are decoded one by one, so an
 * encoded `/` or `\` cannot smuggle a separator, and dot segments are refused
 * outright instead of being normalised away.
 */
export function parseSitePath(pathname: string): { token: string; segments: string[] } | undefined {
	const raw = pathname.split("/");
	if (raw[0] !== "" || !raw[1]) return undefined;
	const segments: string[] = [];
	for (const part of raw.slice(2)) {
		let segment: string;
		try {
			segment = decodeURIComponent(part);
		} catch {
			return undefined;
		}
		if (segment === "") continue;
		if (segment === "." || segment === ".." || /[\u0000-\u001f\\/:]/u.test(segment)) return undefined;
		segments.push(segment);
	}
	return { token: raw[1], segments };
}

/** Encode a workspace-relative path (either separator) as URL path segments. */
export function encodeSitePath(path: string): string {
	return path
		.split(/[\\/]+/)
		.filter(Boolean)
		.map(encodeURIComponent)
		.join("/");
}

function refuse(response: ServerResponse, status: number, text: string): void {
	response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
	response.end(text);
}

interface FileVersion {
	readonly root: string;
	/** Workspace-relative path with `/` separators. */
	readonly path: string;
	readonly body: Buffer;
}

export class SitePreviewServer {
	/** token -> real workspace root. */
	private readonly sites = new Map<string, string>();
	/** rev id -> an earlier version of one file. */
	private readonly versions = new Map<string, FileVersion>();
	/** real workspace root -> token. */
	private readonly tokens = new Map<string, string>();
	private readonly sockets = new Set<Socket>();
	private server?: Server;
	private starting?: Promise<number>;
	private closed = false;

	/**
	 * The preview URL of one workspace file. The caller has already checked that
	 * `cwd` is a workspace this Host knows; the file must exist inside it.
	 */
	async url(cwd: string, inputPath: string): Promise<string> {
		const { root, path } = await this.contained(cwd, inputPath);
		return this.siteUrl(root, path);
	}

	/**
	 * The preview URL of an earlier version of a workspace file whose current
	 * copy still exists. The id is derived from the content, so the same version
	 * keeps one URL and an embedded browser tab already on it is reused.
	 */
	async versionUrl(cwd: string, inputPath: string, text: string): Promise<string> {
		const { root, path } = await this.contained(cwd, inputPath);
		const body = Buffer.from(text, "utf8");
		if (body.length > MAX_VERSION_BYTES) throw new Error("This version is too large to preview");
		const id = createHash("sha256")
			.update(root)
			.update("\0")
			.update(path)
			.update("\0")
			.update(body)
			.digest("base64url");
		const rev = id.slice(0, 24);
		this.versions.delete(rev);
		if (this.versions.size >= MAX_VERSIONS) {
			const oldest = this.versions.keys().next().value;
			if (oldest !== undefined) this.versions.delete(oldest);
		}
		this.versions.set(rev, { root, path, body });
		return `${await this.siteUrl(root, path)}?rev=${rev}`;
	}

	private async contained(cwd: string, inputPath: string): Promise<{ root: string; path: string }> {
		const root = await realpath(cwd);
		const target = await containedWorkspacePath(root, inputPath);
		if (!(await stat(target)).isFile()) throw new Error("Path is not a file");
		return { root, path: relative(root, target).split(sep).join("/") };
	}

	private async siteUrl(root: string, path: string): Promise<string> {
		const port = await this.listen();
		let token = this.tokens.get(root);
		if (!token) {
			token = randomBytes(24).toString("base64url");
			if (this.tokens.size >= MAX_SITES) {
				const [oldest, oldToken] = this.tokens.entries().next().value ?? [];
				if (oldest !== undefined && oldToken !== undefined) {
					this.tokens.delete(oldest);
					this.sites.delete(oldToken);
				}
			}
			this.tokens.set(root, token);
			this.sites.set(token, root);
		}
		return `http://localhost:${port}/${token}/${encodeSitePath(path)}`;
	}

	/** The port, starting the listener on first use. */
	private listen(): Promise<number> {
		if (this.closed) return Promise.reject(new Error("Site preview is stopping"));
		if (!this.starting) {
			const server = createServer((request, response) => {
				void this.handle(request, response).catch(() => {
					if (!response.headersSent) refuse(response, 500, "Preview failed");
					else response.destroy();
				});
			});
			server.on("connection", (socket) => {
				this.sockets.add(socket);
				socket.once("close", () => this.sockets.delete(socket));
			});
			this.server = server;
			this.starting = new Promise<number>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject);
					const address = server.address();
					if (!address || typeof address === "string") reject(new Error("Site preview did not bind"));
					else resolve(address.port);
				});
			});
			// A failed bind may be retried by the next request.
			this.starting.catch(() => {
				this.starting = undefined;
				this.server = undefined;
			});
		}
		return this.starting;
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const method = request.method ?? "GET";
		if (method !== "GET" && method !== "HEAD") {
			response.setHeader("allow", "GET, HEAD");
			return refuse(response, 405, "Method not allowed");
		}
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const parsed = parseSitePath(url.pathname);
		const root = parsed && this.sites.get(parsed.token);
		if (!parsed || !root) return refuse(response, 404, "Not found");
		const rev = url.searchParams.get("rev");
		if (rev !== null) {
			const version = this.versions.get(rev);
			if (!version || version.root !== root || version.path !== parsed.segments.join("/"))
				return refuse(response, 404, "Not found");
			response.writeHead(200, {
				"content-type": siteContentType(version.path),
				"content-length": String(version.body.length),
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				"referrer-policy": "no-referrer",
			});
			response.end(method === "HEAD" ? undefined : version.body);
			return;
		}
		let target: string;
		try {
			target = await containedWorkspacePath(root, parsed.segments.join("/"));
			let info = await stat(target);
			// A folder serves its index page, like a static web server, but is never listed.
			if (info.isDirectory()) {
				target = await containedWorkspacePath(root, join(...parsed.segments, "index.html"));
				info = await stat(target);
			}
			if (!info.isFile()) return refuse(response, 404, "Not found");
			response.writeHead(200, {
				"content-type": siteContentType(target),
				"content-length": String(info.size),
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				// The token is in every URL: a page's outbound requests must not carry it off.
				"referrer-policy": "no-referrer",
			});
		} catch {
			return refuse(response, 404, "Not found");
		}
		if (method === "HEAD") {
			response.end();
			return;
		}
		const stream = createReadStream(target);
		stream.on("error", () => response.destroy());
		response.on("close", () => stream.destroy());
		stream.pipe(response);
	}

	/** Stop listening and drop open connections; tokens die with the process. */
	async close(): Promise<void> {
		this.closed = true;
		const server = this.server;
		this.server = undefined;
		try {
			await this.starting;
		} catch {
			// Never bound: nothing to close.
			return;
		}
		if (!server) return;
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}
