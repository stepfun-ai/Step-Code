import "./bootstrap.ts";

import { createReadStream, existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StepPermissionPresetId } from "@step-harness/coding-agent";
import {
	closeStepMcpPool,
	configureStepMcpPool,
	createStepMcpHostWarmup,
	getStepAccountProfile,
	getStepAuthPath,
	getStepLoginStatus,
	MigrationService,
	openBrowser,
	resolveStepAgentDir,
	resolveStepCodeVersion,
	resolveStepConfigRoot,
	resolveStepSessionDir,
	SessionImportError,
	SessionImportService,
	SessionSearchRequestError,
} from "@step-harness/coding-agent";
import { AccountProfileCache } from "./account.ts";
import { WebAuth } from "./auth.ts";
import { formatStartupBanner, launchUrl, resolveLaunchPort } from "./banner.ts";
import { WebBrowser } from "./browser.ts";
import { recordBrowserOpened, shouldOpenBrowser } from "./browser-open.ts";
import { browserRoute } from "./browser-routes.ts";
import { listWorkflowChildren, readChildTranscript } from "./child-sessions.ts";
import {
	DesktopOnboardingError,
	type DesktopOnboardingState,
	type DesktopOnboardingStatus,
	DesktopOnboardingStore,
} from "./desktop-onboarding.ts";
import { type DirectoryPickerMode, pickNativeDirectory, resolveDirectoryPickerMode } from "./directory-picker.ts";
import {
	absoluteLocalPath,
	completeWorkspaceFiles,
	containedWorkspacePath,
	imageMimeType,
	listDirectory,
	readLocalFile,
	readWorkspaceFile,
	searchWorkspaceFiles,
	type WorkspaceFile,
} from "./files.ts";
import { createBranch, GitBranchError, listLocalBranches, readGitState, switchBranch } from "./git.ts";
import { buildLoginReport, type LoginReport, loginMethods, WebLoginController } from "./login.ts";
import { signOutStep } from "./logout.ts";
import { migrationRoute } from "./migration-routes.ts";
import {
	deleteModelProvider,
	discoverProviderModels,
	hasUsableCustomModel,
	importLocalStepgoModels,
	listModelProviders,
	saveModelProvider,
	testProviderModel,
} from "./model-providers.ts";
import { openFolder } from "./open-folder.ts";
import {
	classifyAttachment,
	defaultWorkspace,
	MAX_ATTACHMENT_BYTES,
	mcpStatuses,
	projectEntry,
	type QueuedFile,
	setLaunchWorkspace,
	type WebAttachment,
	WebSessionStore,
} from "./runtime.ts";
import { searchParamsFromUrl, WebSessionSearch } from "./session-search.ts";
import {
	addMarketplace,
	createSkill,
	deleteMcpServer,
	deleteSkill,
	importSkill,
	installPlugin,
	listMcpServers,
	listPlugins,
	listSkills,
	removeMarketplace,
	removePlugin,
	SettingsError,
	saveMcpServer,
	saveMcpServerPatch,
	setMcpServerEnabled,
	setSkillEnabled,
	updateMarketplace,
} from "./settings.ts";
import { SitePreviewServer } from "./site-preview.ts";
import { WebTerminals } from "./terminal.ts";
import { terminalRoute } from "./terminal-routes.ts";
import { TurnRevertError } from "./turn-changes.ts";
import {
	MAX_UPLOAD_BYTES,
	resolveUpload,
	saveUpload,
	UploadNotFoundError,
	UploadTooLargeError,
	withUploadedFiles,
} from "./uploads.ts";
import { VoiceRelay } from "./voice.ts";
import { voiceRoute } from "./voice-routes.ts";
import {
	canonicalWorkspacePath,
	type DefaultWorkspace,
	firstUseWorkspaceDirectory,
	resolveDefaultWorkspace,
	WORKSPACES_FILE,
	WorkspaceRegistry,
} from "./workspaces.ts";

const moduleRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
/**
 * The built browser client. `vite build` writes it to dist/public, which sits
 * beside dist/server.js; when the server runs from source (tsx src/server.ts)
 * the same build is one level up. A desktop shell may point elsewhere.
 */
const publicRoot = resolve(
	process.env.STEPCODE_WEB_PUBLIC_DIR?.trim() ||
		(existsSync(join(moduleRoot, "public")) ? join(moduleRoot, "public") : join(moduleRoot, "..", "dist", "public")),
);
const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};
const port = Number.parseInt(process.env.STEPCODE_WEB_PORT ?? "3077", 10);
/** Where the launch link points: this host, or the Vite dev server in `pnpm web:watch`. */
const launchPort = resolveLaunchPort(process.env, port);
/**
 * How long shutdown waits for each running turn to record its interrupted
 * reply. The desktop sends SIGKILL 5s after SIGTERM, so this must stay under it:
 * a turn that outlasts the bound is abandoned instead of taking the whole
 * transcript down with an unhandled kill.
 */
const SHUTDOWN_TURN_GRACE_MS = 3_000;
const SECRET_FILE = "web-auth-secret";
const authSecretPath = process.env.STEPCODE_WEB_AUTH_SECRET?.trim() || join(resolveStepConfigRoot(), SECRET_FILE);
const bindHost = "127.0.0.1";
/** Sampled once: the picker a page sees must not change under it. */
const directoryPicker: DirectoryPickerMode = resolveDirectoryPickerMode({
	bindHost,
	platform: process.platform,
	env: process.env,
});
/**
 * When this build was made, from the installer's release envelope
 * (`apps/desktop/src/release-envelope.ts`). A source checkout has none.
 */
const buildTime = normalizeBuildTime(process.env.STEPCODE_BUILD_TIME);

/** A parseable ISO timestamp, or undefined: the page only formats what it can trust. */
function normalizeBuildTime(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || Number.isNaN(Date.parse(trimmed))) return undefined;
	return new Date(trimmed).toISOString();
}
/** One system dialog at a time; a second would stack invisibly behind the first. */
let pickerOpen = false;
const auth = new WebAuth([`http://127.0.0.1:${port}`, `http://localhost:${port}`], authSecretPath);

/**
 * Validate the `attachments` array on a message. Returns an Error so the caller
 * can answer 400 with the reason, or the parsed list (empty when absent).
 *
 * Every field is checked rather than trusted: these bytes are base64-decoded
 * straight into the prompt or an image payload.
 */
function readAttachments(raw: unknown): WebAttachment[] | Error | undefined {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) return new Error("attachments must be an array");
	const attachments: WebAttachment[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") return new Error("each attachment must be an object");
		const { name, mimeType, data } = entry as Record<string, unknown>;
		if (typeof name !== "string" || !name.trim()) return new Error("attachment name is required");
		if (typeof mimeType !== "string" || !mimeType.trim()) return new Error("attachment mimeType is required");
		if (typeof data !== "string" || !data) return new Error("attachment data is required");
		// Base64 of the decoded size, without materialising the buffer.
		const decodedBytes = Math.floor((data.length * 3) / 4);
		if (decodedBytes > MAX_ATTACHMENT_BYTES) {
			return new Error(`attachment ${name} exceeds the ${MAX_ATTACHMENT_BYTES} byte limit`);
		}
		attachments.push({ name, mimeType, data, kind: classifyAttachment(mimeType) });
	}
	return attachments;
}

/**
 * The message text with the content of each uploaded file the composer named
 * (`files`: upload ids in chip order). An Error answers 400: a malformed list
 * or an id whose copy is gone.
 */
async function withFiles(text: string, raw: unknown): Promise<string | Error> {
	if (raw === undefined || raw === null) return text;
	if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
		return new Error("files must be an array of upload ids");
	}
	try {
		return await withUploadedFiles(text, raw as string[]);
	} catch (caught) {
		if (caught instanceof UploadNotFoundError) return caught;
		throw caught;
	}
}

/**
 * The file chips of a queued message (`files`: upload ids in chip order) with
 * their names for the queue row. Their content is added when the message is
 * dispatched, so an edit only ever sees the typed text.
 */
async function readQueuedFiles(raw: unknown): Promise<QueuedFile[] | Error> {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
		return new Error("files must be an array of upload ids");
	}
	const files: QueuedFile[] = [];
	for (const id of new Set(raw as string[])) {
		try {
			files.push({ id, name: (await resolveUpload(id)).name });
		} catch (caught) {
			if (caught instanceof UploadNotFoundError) return caught;
			throw caught;
		}
	}
	return files;
}

function authorized(request: IncomingMessage): boolean {
	const cookie = request.headers.cookie
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith("stepcode_web="))
		?.slice("stepcode_web=".length);
	const fetchSite = request.headers["sec-fetch-site"];
	return auth.authorize(cookie, request.headers.origin, typeof fetchSite === "string" ? fetchSite : undefined);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	let content = "";
	for await (const chunk of request) content += String(chunk);
	if (!content) return {};
	const value: unknown = JSON.parse(content);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object");
	return value as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
	const payload = JSON.stringify(value);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...headers,
	});
	response.end(payload);
}

function error(response: ServerResponse, status: number, message: string): void {
	json(response, status, { error: message });
}

async function serveStatic(_request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
	const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
	const target = resolve(publicRoot, normalize(relativePath));
	if (relative(publicRoot, target).startsWith("..")) return error(response, 404, "Not found");
	try {
		const info = await stat(target);
		if (!info.isFile()) return error(response, 404, "Not found");
		const contentType = STATIC_CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
		// Vite content-hashes everything under /assets/, so those names never change
		// meaning; the document itself is never stored, so a rebuild cannot leave a
		// tab pointing at an asset hash that no longer exists on disk.
		const cacheControl = relativePath.startsWith("assets/")
			? "public, max-age=31536000, immutable"
			: relativePath.endsWith("index.html")
				? "no-store"
				: "no-cache";
		response.writeHead(200, { "content-type": contentType, "cache-control": cacheControl });
		createReadStream(target).pipe(response);
	} catch {
		error(response, 404, "Not found");
	}
}

async function directoryList(inputPath: string): Promise<unknown> {
	const target = await realpath(resolve(inputPath || defaultWorkspace()));
	const info = await stat(target);
	if (!info.isDirectory()) throw new Error("Path is not a directory");
	const entries = await readdir(target, { withFileTypes: true });
	return {
		path: target,
		parent: dirname(target),
		directories: entries
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.sort((left, right) => left.name.localeCompare(right.name))
			.slice(0, 300)
			.map((entry) => ({ name: entry.name, path: join(target, entry.name) })),
	};
}

// Closing one chat must not stop servers the next chat would start again:
// released MCP connections idle in the process pool, and shutdown closes them.
configureStepMcpPool({ quitRelease: "idle" });
/**
 * The host holds the global MCP servers itself, connected from startup, so a
 * new chat's first message already has their tools instead of waiting for them.
 * Re-synced after anything that changes which servers exist or how they start.
 */
const mcpWarmup = createStepMcpHostWarmup();
const resyncMcp = (): void => void mcpWarmup.sync(defaultWorkspace());
const sessionSearch = new WebSessionSearch(resolveStepAgentDir());
const sessionImports = new SessionImportService({
	agentDir: resolveStepAgentDir(),
	sessionRoot: resolveStepSessionDir(),
	onPersisted: (event) => sessionSearch.notifyPersisted(event),
});
const store = new WebSessionStore({ index: sessionSearch });
let migrations: MigrationService | undefined;
let onboarding: DesktopOnboardingStore | undefined;
try {
	migrations = new MigrationService({ agentDir: resolveStepAgentDir(), sessions: sessionImports, env: process.env });
} catch {
	// Optional migration data must not prevent the host from serving existing chats.
}
try {
	onboarding = new DesktopOnboardingStore({ agentDir: resolveStepAgentDir() });
} catch {
	// An unsafe or unavailable onboarding directory is reported by its API, never reset silently.
}
const workspaces = new WorkspaceRegistry(join(resolveStepAgentDir(), WORKSPACES_FILE));
const embeddedBrowser = new WebBrowser([port, launchPort]);
/** Rendered previews of workspace files, on their own origin (see site-preview.ts). */
const sitePreview = new SitePreviewServer();
const terminals = new WebTerminals();
const voice = new VoiceRelay();

/**
 * The first-use workspace, prepared in the background so listening never waits
 * on it (creating a folder under ~/Documents can sit behind a macOS privacy
 * prompt). API requests await it, so the page only ever sees the final launch
 * folder. Failure is logged and leaves the launch folder as it was.
 */
const firstUseWorkspace: Promise<void> = (async () => {
	const directory = firstUseWorkspaceDirectory(process.env);
	if (!directory) return;
	try {
		const path = await workspaces.initializeDefault(directory, async () => (await store.list()).length > 0);
		if (!path) return;
		setLaunchWorkspace(path);
		resyncMcp();
	} catch (caught) {
		console.warn(
			`Could not prepare the default workspace ${directory}: ${caught instanceof Error ? caught.message : String(caught)}`,
		);
	}
})();

/**
 * The default workspace: the folder a new conversation falls back to when no
 * workspace is on offer, and whether it is the home fallback (see
 * `resolveDefaultWorkspace`).
 */
const defaultWorkspaceInfo = (): Promise<DefaultWorkspace> =>
	resolveDefaultWorkspace(workspaces, defaultWorkspace(), homedir());

/**
 * Resolve the `cwd` of a workspace-scoped request, or undefined when the folder
 * is not one this host already works in.
 *
 * File browsing is keyed by folder rather than by session so that a workspace
 * with no conversation yet can still be browsed. That makes the folder a
 * caller-supplied path, so it is checked against what the host already knows:
 * the launch folder, the default workspace, registered workspaces, and the cwd
 * of existing sessions.
 */
async function knownWorkspace(input: string | null): Promise<string | undefined> {
	if (!input) return undefined;
	let cwd: string;
	try {
		cwd = await realpath(input);
	} catch {
		return undefined;
	}
	if (await workspaces.has(cwd)) return cwd;
	const candidates = [
		defaultWorkspace(),
		(await defaultWorkspaceInfo()).path,
		...(await store.list()).map((session) => session.cwd),
	];
	for (const candidate of new Set(candidates)) {
		if (!candidate) continue;
		try {
			if ((await realpath(candidate)) === cwd) return cwd;
		} catch {
			// A session whose folder is gone cannot match a folder that exists.
		}
	}
	return undefined;
}

/** Stream an image from a workspace; the preview loads it through an <img>. */
/**
 * Open the system folder chooser and answer with the chosen path, or null on
 * cancel. The dialog closes if the page goes away before the user answers.
 */
/**
 * Where the model credential comes from, for the settings dialog.
 *
 * Reuses the product's own inspection so the answer matches a terminal
 * `step login status`; only the source and profile are forwarded, never the
 * credential. The inspection can hit the network to validate a token, which is
 * why the answer is cached rather than recomputed per request, and why the
 * cache expires on its own.
 */
const LOGIN_REPORT_TTL_MS = 30_000;
let loginCache: { at: number; value: LoginReport } | undefined;

async function loginReport(): Promise<LoginReport> {
	const now = Date.now();
	if (!loginCache || now - loginCache.at > LOGIN_REPORT_TTL_MS) {
		const authPath = getStepAuthPath();
		loginCache = { at: now, value: buildLoginReport({ status: await getStepLoginStatus({ authPath }), authPath }) };
	}
	return loginCache.value;
}

/**
 * Sign-in from the page. A saved credential invalidates the cached report and
 * the open sessions, which were built without it.
 */
/**
 * The signed-in account's name and avatar, for the sidebar footer. The session
 * is read beside the credential file this host uses, the same place a sign-in
 * from this host or a terminal `step login` writes it.
 */
const account = new AccountProfileCache(() =>
	getStepAccountProfile({ env: { ...process.env, STEPCODE_AUTH_PATH: getStepAuthPath() } }),
);

const login = new WebLoginController({
	authPath: () => getStepAuthPath(),
	onSaved: () => {
		loginCache = undefined;
		account.invalidate();
		void store.reloadCredentials();
		// The Step login key is part of a server's environment: reconnect with it.
		resyncMcp();
	},
});

async function signInWithApiKey(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const input = await body(request);
	if (!login.isApiKeyMethod(input.profile)) return error(response, 400, "Unknown API key login profile");
	if (typeof input.apiKey !== "string" || !input.apiKey.trim()) return error(response, 400, "apiKey is required");
	const result = await login.withApiKey(input.profile, input.apiKey);
	if (!result.ok) {
		return json(response, result.code === "invalid_key" ? 400 : 502, { error: result.error, code: result.code });
	}
	return json(response, 200, {
		login: await loginReport(),
		...(result.warning ? { warning: result.warning } : {}),
	});
}

/**
 * Sign out of Step, not just the page.
 *
 * `step logout` removes the stored credential, the legacy copies and the
 * account session. The page cookie is deliberately left alone: it only
 * authorizes this browser window, and desktop reloads into the sign-in gate (or,
 * with a custom model still usable, straight into the app)
 * without needing a new terminal launch link.
 */
async function signOutOfStep(response: ServerResponse): Promise<void> {
	await login.cancelAll();
	const outcome = await signOutStep({
		authPath: getStepAuthPath(),
		env: process.env,
		stopSessions: () => store.interruptAndClose(),
	});
	loginCache = undefined;
	account.invalidate();
	resyncMcp();
	const [report, customModels] = await Promise.all([loginReport(), hasUsableCustomModel()]);
	return json(response, 200, { ...outcome, customModels, login: report });
}

async function pickWorkspaceFolder(request: IncomingMessage, response: ServerResponse): Promise<void> {
	if (directoryPicker !== "native") return error(response, 409, "The system folder picker is not available");
	if (pickerOpen) return error(response, 409, "A folder picker is already open");
	const input = await body(request);
	const title =
		typeof input.title === "string" && input.title.trim()
			? input.title.trim().slice(0, 120)
			: "Select Workspace Directory";
	const startIn = typeof input.startIn === "string" ? input.startIn : undefined;
	const controller = new AbortController();
	response.on("close", () => {
		if (!response.writableFinished) controller.abort();
	});
	pickerOpen = true;
	try {
		const path = await pickNativeDirectory({ title, startIn, signal: controller.signal });
		return json(response, 200, { path });
	} catch (caught) {
		if (controller.signal.aborted) return;
		return error(response, 500, caught instanceof Error ? caught.message : String(caught));
	} finally {
		pickerOpen = false;
	}
}

/**
 * `/api/v1/workspace/git/*`: the composer branch pill (see git.ts). `parts`
 * starts after `git`, URL-decoded: nothing (state + branches), `switch` or
 * `branches`. A branch operation is a write, so it answers 400 with the code
 * and blocking paths the client renders instead of a bare message.
 */
async function gitRoute(
	parts: string[],
	method: string,
	url: URL,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const cwd = await knownWorkspace(url.searchParams.get("cwd"));
	if (!cwd) return error(response, 403, "Folder is not a known workspace");
	try {
		if (parts.length === 0 && method === "GET") {
			const state = await readGitState(cwd);
			if (!state.repository) return json(response, 200, { state, branches: [] });
			const { branches } = await listLocalBranches(cwd, state);
			return json(response, 200, { state, branches });
		}
		if (parts.length === 1 && parts[0] === "switch" && method === "POST") {
			const input = await body(request);
			if (typeof input.branch !== "string" || !input.branch.trim()) {
				return error(response, 400, "branch is required");
			}
			const create = input.create === true;
			const state = create
				? await createBranch(cwd, input.branch, typeof input.from === "string" ? input.from : undefined)
				: await switchBranch(cwd, input.branch);
			return json(response, 200, { state });
		}
		return error(response, 404, "Not found");
	} catch (caught) {
		if (!(caught instanceof GitBranchError)) throw caught;
		// Not a repository or no git on PATH is the caller's folder, not a server fault.
		return json(response, 400, { error: caught.message, code: caught.code, paths: caught.paths });
	}
}

/**
 * `/api/v1/settings/*`: the settings screen's MCP, plugin, marketplace and skill
 * management (see settings.ts). `parts` starts after `settings`, URL-decoded.
 */
async function settingsRoute(
	parts: string[],
	method: string,
	url: URL,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const [area, name, action] = parts;
	const changesMcp = method !== "GET" && (area === "mcp" || area === "plugins" || area === "marketplaces");
	try {
		if (area === "mcp") {
			if (!name && method === "GET") return json(response, 200, { servers: await listMcpServers() });
			if (!name && method === "POST") {
				const input = await body(request);
				if (typeof input.name !== "string") return error(response, 400, "name is required");
				saveMcpServer(input.name.trim(), input.config, { replace: false });
				return json(response, 201, { ok: true });
			}
			if (name && !action && method === "PUT") {
				const input = await body(request);
				if (Object.keys(input).some((key) => key !== "patch") || !input.patch) {
					return error(response, 400, "A revision-checked MCP settings patch is required");
				}
				saveMcpServerPatch(name, input.patch);
				return json(response, 200, { ok: true });
			}
			if (name && !action && method === "PATCH") {
				const input = await body(request);
				if (typeof input.enabled !== "boolean") return error(response, 400, "enabled must be a boolean");
				await setMcpServerEnabled(name, input.enabled);
				return json(response, 200, { ok: true });
			}
			if (name && !action && method === "DELETE") {
				deleteMcpServer(name);
				return json(response, 200, { ok: true });
			}
		}
		if (area === "plugins") {
			if (!name && method === "GET") return json(response, 200, await listPlugins());
			if (!name && method === "POST") {
				const input = await body(request);
				if (typeof input.name !== "string" || !input.name.trim()) return error(response, 400, "name is required");
				const marketplace = typeof input.marketplace === "string" ? input.marketplace : undefined;
				return json(response, 201, await installPlugin(input.name.trim(), marketplace));
			}
			if (name && !action && method === "DELETE") {
				await removePlugin(name);
				return json(response, 200, { ok: true });
			}
		}
		if (area === "marketplaces") {
			if (!name && method === "POST") {
				const input = await body(request);
				if (typeof input.source !== "string" || !input.source.trim()) {
					return error(response, 400, "source is required");
				}
				return json(response, 201, await addMarketplace(input.source));
			}
			if (name && action === "update" && method === "POST")
				return json(response, 200, await updateMarketplace(name));
			if (name && !action && method === "DELETE") {
				await removeMarketplace(name);
				return json(response, 200, { ok: true });
			}
		}
		if (area === "skills") {
			if (!name && method === "GET") return json(response, 200, { skills: await listSkills() });
			if (!name && method === "POST") {
				const input = await body(request);
				await createSkill({ name: input.name, description: input.description, instructions: input.instructions });
				return json(response, 201, { ok: true });
			}
			if (name === "import" && !action && method === "POST") {
				return json(response, 201, await importSkill((await body(request)).path));
			}
			// A skill's id is its file path, so it travels in the body or the query, not the URL path.
			if (!name && method === "PATCH") {
				const input = await body(request);
				if (typeof input.id !== "string" || typeof input.enabled !== "boolean") {
					return error(response, 400, "id and enabled are required");
				}
				await setSkillEnabled(input.id, input.enabled);
				return json(response, 200, { ok: true });
			}
			if (!name && method === "DELETE") {
				await deleteSkill(url.searchParams.get("id") ?? "");
				return json(response, 200, { ok: true });
			}
		}
		if (area === "models") {
			if (!name && method === "GET") return json(response, 200, { providers: await listModelProviders() });
			if (!name && method === "POST") {
				const input = await body(request);
				if (typeof input.id !== "string") return error(response, 400, "id is required");
				await saveModelProvider(input.id.trim(), input, { replace: false });
				return json(response, 201, { ok: true });
			}
			// Discovery answers for the draft in the form, so it takes the address,
			// protocol and key from the body rather than from a saved provider.
			if (name === "discover" && !action && method === "POST") {
				return json(response, 200, { models: await discoverProviderModels(await body(request)) });
			}
			// A connection test answers for the same draft in the form.
			if (name === "test" && !action && method === "POST") {
				await testProviderModel(await body(request));
				return json(response, 200, { ok: true });
			}
			if (name && !action && method === "PUT") {
				// A blank key field keeps the stored key; only an explicit flag removes it.
				const input = await body(request);
				await saveModelProvider(name, input, { replace: true, removeKey: input.removeKey === true });
				return json(response, 200, { ok: true });
			}
			if (name && !action && method === "DELETE") {
				await deleteModelProvider(name);
				return json(response, 200, { ok: true });
			}
		}
		return error(response, 404, "Not found");
	} catch (caught) {
		if (caught instanceof SettingsError) return error(response, caught.status, caught.message);
		throw caught;
	} finally {
		// Connect what was added or enabled now; what was removed closes once no chat uses it.
		if (changesMcp && response.statusCode < 400) resyncMcp();
	}
}

/** `GET /api/v1/search`: full-text search over every session. A client that goes away cancels the query. */
async function searchSessions(url: URL, response: ServerResponse): Promise<void> {
	const controller = new AbortController();
	response.on("close", () => {
		if (!response.writableFinished) controller.abort();
	});
	try {
		return json(response, 200, await sessionSearch.search(searchParamsFromUrl(url), controller.signal));
	} catch (caught) {
		if (controller.signal.aborted) return;
		if (caught instanceof SessionSearchRequestError) {
			return json(response, 400, { error: caught.message, code: caught.code });
		}
		throw caught;
	}
}

/** GET workspace file completion; a disconnected composer cancels its bounded walk. */
async function completeFiles(cwd: string, url: URL, response: ServerResponse): Promise<void> {
	const query = url.searchParams.get("q");
	if (query === null) return error(response, 400, "q is required");
	const controller = new AbortController();
	const onClose = () => {
		if (!response.writableFinished) controller.abort();
	};
	response.on("close", onClose);
	try {
		const listing = await completeWorkspaceFiles(cwd, query, controller.signal);
		if (!controller.signal.aborted) return json(response, 200, listing);
	} catch (caught) {
		if (controller.signal.aborted) return;
		return error(response, 400, caught instanceof Error ? caught.message : String(caught));
	} finally {
		response.off("close", onClose);
	}
}

async function serveImageFile(
	response: ServerResponse,
	target: string,
	file: Extract<WorkspaceFile, { kind: "image" }>,
): Promise<void> {
	response.writeHead(200, {
		"content-type": file.mimeType,
		"content-length": String(file.size),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	createReadStream(target).pipe(response);
}

async function serveWorkspaceImage(response: ServerResponse, cwd: string, inputPath: string): Promise<void> {
	const file = await readWorkspaceFile(cwd, inputPath);
	if (file.kind !== "image") {
		imageRefused(response, file, inputPath);
		return;
	}
	await serveImageFile(response, await containedWorkspacePath(cwd, inputPath), file);
}

async function serveLocalImage(response: ServerResponse, inputPath: string): Promise<void> {
	const file = await readLocalFile(inputPath);
	if (file.kind !== "image") {
		imageRefused(response, file, inputPath);
		return;
	}
	await serveImageFile(response, await absoluteLocalPath(inputPath), file);
}

/**
 * Why a raw request was refused. The preview never asks for an oversized image
 * (the read classifies it as "too large"), so this only answers a direct caller:
 * an image over the limit keeps its documented 413, everything else is simply
 * not servable here.
 */
function imageRefused(response: ServerResponse, file: WorkspaceFile, inputPath: string): void {
	if (file.kind === "too-large" && imageMimeType(inputPath)) {
		error(response, 413, "Image is too large to preview");
		return;
	}
	error(response, 415, "Only images can be served raw");
}

const server = createServer(async (request, response) => {
	try {
		const method = request.method ?? "GET";
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
		if (url.pathname === "/auth/exchange" && method === "POST") {
			const input = await body(request);
			const cookie = auth.exchange(input.token, request.headers.origin);
			if (!cookie) return error(response, 401, "Launch token is invalid, already used, or origin is not allowed");
			return json(
				response,
				200,
				{ ok: true },
				{ "set-cookie": `stepcode_web=${cookie}; HttpOnly; SameSite=Strict; Path=/` },
			);
		}
		// Page-session only: expire this browser's cookie. It never touches
		// `auth.json`/`step-login.json`; Account and the account menu use
		// `POST /api/v1/logout` for the Step sign-out.
		if (url.pathname === "/auth/logout" && method === "POST") {
			if (!auth.allowsOrigin(request.headers.origin)) return error(response, 403, "Origin is not allowed");
			return json(
				response,
				200,
				{ ok: true },
				{ "set-cookie": "stepcode_web=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" },
			);
		}
		if (url.pathname === "/healthz") return json(response, 200, { ok: true });
		if (!url.pathname.startsWith("/api/")) return serveStatic(request, response, url.pathname);
		if (!authorized(request)) return error(response, 401, "Authentication required");
		await firstUseWorkspace;

		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] !== "api" || parts[1] !== "v1") return error(response, 404, "Not found");
		if (parts[2] === "browser") return await browserRoute(embeddedBrowser, parts.slice(3), request, response);
		if (parts[2] === "terminals")
			return await terminalRoute(terminals, parts.slice(3), url, request, response, knownWorkspace);
		if (parts[2] === "voice") return await voiceRoute(voice, parts.slice(3), request, response);
		if (parts[2] === "migrations") {
			if (!migrations) return json(response, 503, { error: "migration-unavailable", code: "migration-unavailable" });
			return await migrationRoute(migrations, parts.slice(3), url, request, response);
		}
		if (parts[2] === "desktop-onboarding" && parts.length === 3) {
			if (!onboarding)
				return json(response, 503, { error: "onboarding-unavailable", code: "onboarding-unavailable" });
			try {
				if (method === "GET") return json(response, 200, onboarding.get());
				if (method === "PATCH") {
					const input = await body(request);
					const statuses: DesktopOnboardingStatus[] = ["unseen", "offered", "in_progress", "completed", "skipped"];
					if (
						Object.keys(input).some((key) => !["expectedRevision", "status", "lastJobId"].includes(key)) ||
						typeof input.expectedRevision !== "number" ||
						typeof input.status !== "string" ||
						!statuses.includes(input.status as DesktopOnboardingStatus) ||
						(input.lastJobId !== undefined && typeof input.lastJobId !== "string")
					) {
						return json(response, 400, { error: "invalid-onboarding-data", code: "invalid-onboarding-data" });
					}
					return json(
						response,
						200,
						onboarding.update({
							expectedRevision: input.expectedRevision,
							status: input.status as DesktopOnboardingStatus,
							...(typeof input.lastJobId === "string" ? { lastJobId: input.lastJobId } : {}),
						}),
					);
				}
				return error(response, 404, "Not found");
			} catch (caught) {
				const code = caught instanceof DesktopOnboardingError ? caught.code : "onboarding-unavailable";
				return json(response, caught instanceof DesktopOnboardingError ? caught.status : 503, {
					error: code,
					code,
				});
			}
		}
		if (parts[2] === "bootstrap" && method === "GET") {
			const [report, customModels, defaultInfo] = await Promise.all([
				loginReport(),
				hasUsableCustomModel(),
				defaultWorkspaceInfo(),
			]);
			let desktopOnboarding: DesktopOnboardingState | undefined;
			try {
				desktopOnboarding = onboarding?.get();
			} catch {
				/* The explicit onboarding API reports recovery errors. */
			}
			const [existingSessions, existingWorkspaces] =
				desktopOnboarding?.status === "unseen" ? await Promise.all([store.list(), workspaces.list()]) : [[], []];
			const migrationSuggested =
				!!migrations &&
				desktopOnboarding?.status === "unseen" &&
				!existingSessions.length &&
				!existingWorkspaces.some((workspace) => workspace.hidden);
			// The identity of the running build, so a page (and the person looking at
			// it) can tell which build it is talking to. `buildTime` is staged beside
			// the server entry by the installer; a source checkout reports none.
			return json(response, 200, {
				// The page names its launch folder with this, and it has to agree with
				// the cwd session headers record and the registry stores. Reporting the
				// spelling the process was started with (a symlinked folder, a trailing
				// slash) made the removed real folder keep appearing in the composer's
				// picker, because only the canonical spelling was marked hidden.
				cwd: await canonicalWorkspacePath(defaultWorkspace()),
				// Where a new conversation starts when the launch folder has been
				// removed from workspace navigation (see `defaultWorkspaceInfo`), and
				// whether that folder is the fallback the page names "默认项目".
				defaultCwd: await canonicalWorkspacePath(defaultInfo.path),
				defaultCwdFallback: defaultInfo.fallback,
				directoryPicker,
				login: report,
				customModels,
				migrationAvailable: !!migrations,
				migrationSuggested,
				...(desktopOnboarding ? { desktopOnboarding } : {}),
				version: resolveStepCodeVersion().value,
				...(buildTime ? { buildTime } : {}),
			});
		}
		if (parts[2] === "account" && parts.length === 3 && method === "GET") {
			return json(response, 200, await account.get());
		}
		if (parts[2] === "login" && parts.length === 3 && method === "GET") {
			return json(response, 200, await loginReport());
		}
		if (parts[2] === "login" && parts.length === 4) {
			if (parts[3] === "methods" && method === "GET") return json(response, 200, { methods: loginMethods() });
			if (parts[3] === "api-key" && method === "POST") return signInWithApiKey(request, response);
			if (parts[3] === "browser") {
				if (method === "GET") return json(response, 200, login.browserState());
				if (method === "DELETE") {
					login.cancelBrowser();
					return json(response, 200, { ok: true });
				}
				if (method === "POST") {
					const input = await body(request);
					if (!login.isBrowserMethod(input.profile)) return error(response, 400, "Unknown browser login profile");
					const state = await login.startBrowser(input.profile);
					if (state.state === "failed") return json(response, 502, { error: state.error, code: "failed" });
					return json(response, 200, state);
				}
			}
		}
		if (parts[2] === "logout" && parts.length === 3 && method === "POST") {
			return signOutOfStep(response);
		}
		if (parts[2] === "workspaces" && parts[3] === "pick" && parts.length === 4 && method === "POST") {
			return pickWorkspaceFolder(request, response);
		}
		if (parts[2] === "uploads" && parts.length === 3 && method === "POST") {
			const name = url.searchParams.get("name") ?? "";
			if (!name.trim()) return error(response, 400, "name is required");
			if (Number(request.headers["content-length"] ?? 0) > MAX_UPLOAD_BYTES) {
				return error(response, 413, `File exceeds the ${MAX_UPLOAD_BYTES} byte limit`);
			}
			try {
				return json(response, 201, await saveUpload(request, name));
			} catch (caught) {
				if (caught instanceof UploadTooLargeError) return error(response, 413, caught.message);
				throw caught;
			}
		}
		if (parts[2] === "directories" && method === "GET") {
			return json(response, 200, await directoryList(url.searchParams.get("path") ?? defaultWorkspace()));
		}
		if (parts[2] === "workspaces" && parts.length === 3) {
			if (method === "GET") {
				// Kept fresh here as well as at bootstrap: removing the launch folder
				// changes this answer mid-session, and the reroute that follows a
				// removal reads it.
				const [list, info] = await Promise.all([workspaces.list(), defaultWorkspaceInfo()]);
				return json(response, 200, {
					workspaces: list,
					defaultCwd: await canonicalWorkspacePath(info.path),
					defaultCwdFallback: info.fallback,
				});
			}
			if (method === "POST") {
				const input = await body(request);
				if (typeof input.path !== "string") return error(response, 400, "path is required");
				try {
					return json(response, 201, await workspaces.add(input.path));
				} catch (caught) {
					return error(response, 400, caught instanceof Error ? caught.message : String(caught));
				}
			}
			if (method === "DELETE") {
				const removed = await workspaces.remove(url.searchParams.get("path") ?? "");
				return removed ? json(response, 200, { ok: true }) : error(response, 404, "Workspace is not registered");
			}
		}
		// Read-only preview of one file named by an absolute path from message
		// content. Same cookie authentication as every other route; unlike
		// /workspace/* there is no folder-registry check — the path is the
		// user's own message reference, and these routes only read a single
		// known file, never list directories or write.
		if (
			parts[2] === "file" &&
			method === "GET" &&
			(parts.length === 3 || (parts.length === 4 && parts[3] === "raw"))
		) {
			const inputPath = url.searchParams.get("path") ?? "";
			try {
				if (parts.length === 4) return await serveLocalImage(response, inputPath);
				return json(response, 200, await readLocalFile(inputPath));
			} catch (caught) {
				return error(response, 400, caught instanceof Error ? caught.message : String(caught));
			}
		}
		// Show the workspace folder in Finder / File Explorer: only a folder this Host already works in.
		if (parts[2] === "workspace" && parts[3] === "open" && parts.length === 4 && method === "POST") {
			const cwd = await knownWorkspace(url.searchParams.get("cwd"));
			if (!cwd) return error(response, 403, "Folder is not a known workspace");
			try {
				await openFolder(cwd);
				return json(response, 200, { ok: true });
			} catch (caught) {
				return error(response, 500, caught instanceof Error ? caught.message : String(caught));
			}
		}
		if (parts[2] === "workspace" && parts[3] === "site" && parts.length === 4 && method === "POST") {
			const cwd = await knownWorkspace(url.searchParams.get("cwd"));
			if (!cwd) return error(response, 403, "Folder is not a known workspace");
			try {
				return json(response, 200, { url: await sitePreview.url(cwd, url.searchParams.get("path") ?? "") });
			} catch (caught) {
				return error(response, 400, caught instanceof Error ? caught.message : String(caught));
			}
		}
		if (parts[2] === "workspace" && parts.length === 4 && method === "GET") {
			const cwd = await knownWorkspace(url.searchParams.get("cwd"));
			if (!cwd) return error(response, 403, "Folder is not a known workspace");
			const path = url.searchParams.get("path") ?? "";
			if (parts[3] === "completions") return await completeFiles(cwd, url, response);
			try {
				if (parts[3] === "files") return json(response, 200, await listDirectory(cwd, path));
				if (parts[3] === "file") return json(response, 200, await readWorkspaceFile(cwd, path));
				if (parts[3] === "raw") return await serveWorkspaceImage(response, cwd, path);
				if (parts[3] === "skills") return json(response, 200, await store.slashResourcesFor(cwd));
				if (parts[3] === "search") {
					return json(response, 200, await searchWorkspaceFiles(cwd, url.searchParams.get("q") ?? ""));
				}
			} catch (caught) {
				// A bad path inside a valid workspace is the caller's mistake.
				return error(response, 400, caught instanceof Error ? caught.message : String(caught));
			}
		}
		if (parts[2] === "workspace" && parts[3] === "git") {
			return await gitRoute(parts.slice(4).map(decodeURIComponent), method, url, request, response);
		}
		if (parts[2] === "session-imports") {
			try {
				if (parts.length === 3 && method === "GET")
					return json(response, 200, { jobs: await sessionImports.listJobs() });
				if (parts.length === 4 && parts[3] === "scan" && method === "POST") {
					const input = await body(request);
					for (const key of Object.keys(input))
						if (key !== "includeArchived")
							return error(response, 400, "Only default-directory scanning is supported");
					if (input.includeArchived !== undefined && typeof input.includeArchived !== "boolean")
						return error(response, 400, "includeArchived must be a boolean");
					return json(
						response,
						200,
						await sessionImports.scan({
							includeArchived: input.includeArchived === true,
						}),
					);
				}
				if (parts.length === 4 && parts[3] === "preview" && method === "POST") {
					const input = await body(request);
					if (typeof input.candidateId !== "string") return error(response, 400, "candidateId is required");
					return json(response, 200, await sessionImports.preview(input.candidateId));
				}
				if (parts.length === 3 && method === "POST") {
					const input = await body(request);
					if (!Array.isArray(input.selections)) return error(response, 400, "selections are required");
					const selections: { candidateId: string; fingerprint: string; cwd: string }[] = [];
					for (const value of input.selections) {
						if (
							!value ||
							typeof value !== "object" ||
							!("candidateId" in value) ||
							typeof value.candidateId !== "string" ||
							!("fingerprint" in value) ||
							typeof value.fingerprint !== "string" ||
							!("cwd" in value) ||
							typeof value.cwd !== "string"
						)
							return error(response, 400, "Invalid import selection");
						selections.push({ candidateId: value.candidateId, fingerprint: value.fingerprint, cwd: value.cwd });
					}
					return json(response, 202, await sessionImports.start(selections));
				}
				if (parts.length === 4 && method === "GET")
					return json(response, 200, await sessionImports.getJob(parts[3]));
				if (parts.length === 4 && method === "DELETE")
					return json(response, 200, await sessionImports.cancel(parts[3]));
				return error(response, 404, "Not found");
			} catch (caught) {
				if (caught instanceof SessionImportError) return error(response, caught.status, caught.message);
				return error(response, 400, caught instanceof Error ? caught.message : String(caught));
			}
		}
		if (parts[2] === "settings" && parts[3]) {
			return await settingsRoute(parts.slice(3).map(decodeURIComponent), method, url, request, response);
		}
		if (parts[2] === "mcp" && parts.length === 3 && method === "GET") {
			return json(response, 200, { servers: mcpStatuses() });
		}
		if (parts[2] === "models" && parts.length === 3 && method === "GET") {
			// Unknown folders fall back to the launch folder: project settings are
			// read from the cwd, so an arbitrary path must not pick which ones.
			const cwd = (await knownWorkspace(url.searchParams.get("cwd"))) ?? defaultWorkspace();
			return json(response, 200, await store.draftModels(cwd));
		}
		if (parts[2] === "search" && method === "GET") {
			if (parts.length === 4 && parts[3] === "status") return json(response, 200, await sessionSearch.status());
			if (parts.length === 3) return searchSessions(url, response);
		}
		if (parts[2] === "sessions" && parts.length === 3 && method === "GET") {
			const sessions = await store.list();
			return json(response, 200, { sessions });
		}
		if (parts[2] === "session-status" && parts.length === 3 && method === "GET") {
			return json(response, 200, { sessions: store.statuses() });
		}
		if (parts[2] === "sessions" && parts.length === 3 && method === "POST") {
			const input = await body(request);
			const session = await store.create(typeof input.cwd === "string" ? input.cwd : defaultWorkspace());
			return json(response, 201, session.snapshot());
		}
		if (parts[2] === "sessions" && parts[3]) {
			if (parts.length === 4 && method === "DELETE") {
				await store.delete(parts[3]);
				return json(response, 200, { ok: true });
			}
			const session = await store.getOrOpen(parts[3]);
			if (parts.length === 4 && method === "GET") return json(response, 200, session.snapshot());
			if (parts.length === 5 && parts[4] === "inspector" && method === "GET")
				return json(response, 200, session.inspector());
			if (parts[4] === "children" && method === "GET") {
				if (parts.length === 6) {
					const childId = decodeURIComponent(parts[5]);
					const child = await readChildTranscript(session.id, session.sessionFile(), childId);
					if (!child) return error(response, 404, "Child session not found");
					return json(response, 200, {
						...child,
						parentId: session.id,
						readOnly: true,
						entries: child.entries.map(projectEntry),
					});
				}
				if (parts.length === 5) {
					const runId = url.searchParams.get("workflowRun");
					if (!runId) return error(response, 400, "workflowRun is required");
					return json(response, 200, {
						children: await listWorkflowChildren(session.id, session.sessionFile(), runId),
					});
				}
			}
			if (parts[4] === "events" && method === "GET") {
				response.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				response.write(`event: snapshot\ndata: ${JSON.stringify(session.snapshot())}\n\n`);
				const unsubscribe = session.subscribe((event) => {
					const eventName = event.type === "error" ? "web_error" : event.type;
					response.write(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`);
				});
				// Following the stream is looking at the session: its outcome is seen.
				const unwatch = session.watch();
				// A closed session (e.g. rebuilt after sign-in) sends nothing more; end
				// the stream so the page's EventSource reconnects to its replacement.
				const stopOnClose = session.onClose(() => response.end());
				response.on("close", () => {
					unsubscribe();
					unwatch();
					stopOnClose();
				});
				return;
			}
			if (parts[4] === "messages" && method === "POST") {
				const input = await body(request);
				if (typeof input.text !== "string" || !input.text.trim()) return error(response, 400, "text is required");
				const attachments = readAttachments(input.attachments);
				if (attachments instanceof Error) return error(response, 400, attachments.message);
				const text = await withFiles(input.text, input.files);
				if (text instanceof Error) return error(response, 400, text.message);
				if (session.isReverting()) return error(response, 409, "Wait for the revert to finish");
				void session.send(text, attachments ?? []).catch((caught) => {
					session.publishError(caught instanceof Error ? caught.message : String(caught));
				});
				return json(response, 202, { ok: true });
			}
			if (parts[4] === "steer" && method === "POST") {
				const input = await body(request);
				if (typeof input.text !== "string" || !input.text.trim()) return error(response, 400, "text is required");
				const attachments = readAttachments(input.attachments);
				if (attachments instanceof Error) return error(response, 400, attachments.message);
				const text = await withFiles(input.text, input.files);
				if (text instanceof Error) return error(response, 400, text.message);
				// Queuing a steer is immediate; a refusal (an extension command) is this request's error.
				try {
					await session.steer(text, attachments ?? []);
				} catch (caught) {
					return error(response, 400, caught instanceof Error ? caught.message : String(caught));
				}
				return json(response, 202, { ok: true });
			}
			if (parts[4] === "queue") {
				const itemId = parts[5] ? decodeURIComponent(parts[5]) : undefined;
				if (parts.length === 5 && method === "POST") {
					const input = await body(request);
					if (typeof input.text !== "string" || !input.text.trim())
						return error(response, 400, "text is required");
					const attachments = readAttachments(input.attachments);
					if (attachments instanceof Error) return error(response, 400, attachments.message);
					const files = await readQueuedFiles(input.files);
					if (files instanceof Error) return error(response, 400, files.message);
					session.enqueue({ text: input.text.trim(), attachments: attachments ?? [], files });
					return json(response, 202, session.queueState());
				}
				// `queue/steer` steers every queued message; `queue/<id>/steer` one of them.
				const steerAll = parts.length === 6 && parts[5] === "steer";
				const steerOne = parts.length === 7 && parts[6] === "steer" && itemId;
				if ((steerAll || steerOne) && method === "POST") {
					try {
						const steered = await session.steerQueued(steerOne ? [steerOne] : undefined);
						if (!steered) return error(response, 404, "Queued message not found");
					} catch (caught) {
						return error(response, 409, caught instanceof Error ? caught.message : String(caught));
					}
					return json(response, 202, session.queueState());
				}
				if (itemId && parts.length === 6 && method === "PATCH") {
					const input = await body(request);
					if (typeof input.text !== "string" || !input.text.trim())
						return error(response, 400, "text is required");
					if (!session.editQueued(itemId, input.text.trim()))
						return error(response, 404, "Queued message not found");
					return json(response, 200, session.queueState());
				}
				if (itemId && parts.length === 6 && method === "DELETE") {
					if (!session.removeQueued(itemId)) return error(response, 404, "Queued message not found");
					return json(response, 200, session.queueState());
				}
			}
			if (parts[4] === "interrupt" && method === "POST") {
				await session.interrupt();
				return json(response, 200, { ok: true });
			}
			if (parts[4] === "clarifications" && parts[5] === "response" && parts.length === 6 && method === "POST") {
				const input = await body(request);
				if (typeof input.id !== "string") return error(response, 400, "Clarification id is required");
				try {
					if (!session.clarifications.respond(input.id, input))
						return error(response, 404, "Clarification not found");
				} catch (caught) {
					return error(response, 400, caught instanceof Error ? caught.message : String(caught));
				}
				return json(response, 200, { ok: true });
			}
			if (parts[4] === "selections" && parts[5] === "response" && parts.length === 6 && method === "POST") {
				const input = await body(request);
				if (typeof input.id !== "string") return error(response, 400, "Selection id is required");
				// An absent value means the user dismissed the dialog.
				if (input.value !== undefined && typeof input.value !== "string")
					return error(response, 400, "value must be a string");
				if (!(await session.respondSelection(input.id, input.value)))
					return error(response, 404, "Selection not found");
				return json(response, 200, session.snapshot());
			}
			if (parts[4] === "text-inputs" && parts[5] === "response" && parts.length === 6 && method === "POST") {
				const input = await body(request);
				if (typeof input.id !== "string") return error(response, 400, "Text input id is required");
				// An absent value means the user dismissed the dialog; "" is a real answer.
				if (input.value !== undefined && typeof input.value !== "string")
					return error(response, 400, "value must be a string");
				if (!session.respondTextInput(input.id, input.value)) return error(response, 404, "Text input not found");
				return json(response, 200, session.snapshot());
			}
			if (parts[4] === "side-answers" && parts[5] === "clear" && parts.length === 6 && method === "POST") {
				session.clearSideAnswers();
				return json(response, 200, { ok: true });
			}
			if (parts[4] === "approvals" && parts[5] === "decision" && method === "POST") {
				const input = await body(request);
				const verdict = input.verdict;
				if (verdict !== "approve" && verdict !== "approve_for_session" && verdict !== "deny")
					return error(response, 400, "Invalid verdict");
				if (typeof input.id !== "string" || !(await session.decideApproval(input.id, verdict)))
					return error(response, 404, "Approval not found");
				return json(response, 200, { ok: true });
			}
			if (parts[4] === "skills" && parts.length === 5 && method === "GET") {
				return json(response, 200, { skills: session.skills(), commands: session.commands() });
			}
			// A delivered page as its turn left it: later turns' patches reversed, served beside the
			// workspace on the site preview origin. Falls back to the current file when that is not exact.
			if (parts[4] === "turns" && parts[5] && parts[6] === "site" && parts.length === 7 && method === "POST") {
				const path = url.searchParams.get("path") ?? "";
				try {
					const version = await session.fileAtTurn(decodeURIComponent(parts[5]), path);
					const target =
						version.text === undefined
							? await sitePreview.url(session.cwd, path)
							: await sitePreview.versionUrl(session.cwd, path, version.text);
					return json(response, 200, { url: target, exact: version.exact });
				} catch (caught) {
					return error(response, 400, caught instanceof Error ? caught.message : String(caught));
				}
			}
			if (parts[4] === "turns" && parts[5] && parts[6] === "revert" && parts.length === 7 && method === "POST") {
				try {
					const { paths, skipped } = await session.revertTurn(decodeURIComponent(parts[5]));
					return json(response, 200, { snapshot: session.snapshot(), paths, skipped });
				} catch (caught) {
					// A file changed since the turn, or the turn is running: the caller's state, not a server fault.
					if (caught instanceof TurnRevertError)
						return json(response, 409, { error: caught.message, code: caught.code, path: caught.path });
					throw caught;
				}
			}
			if (parts[4] === "name" && method === "PATCH") {
				const input = await body(request);
				if (typeof input.name !== "string") return error(response, 400, "name is required");
				await session.rename(input.name);
				return json(response, 200, session.snapshot());
			}
			if (parts[4] === "archive" && method === "PATCH") {
				const input = await body(request);
				if (typeof input.archived !== "boolean") return error(response, 400, "archived is required");
				await store.archive(session.id, input.archived);
				return json(response, 200, session.snapshot());
			}
			if (parts[4] === "policy" && method === "PATCH") {
				const input = await body(request);
				if (typeof input.preset !== "string") return error(response, 400, "preset is required");
				try {
					await session.setPolicy(input.preset as StepPermissionPresetId);
				} catch (caught) {
					// An unknown preset, or a switch while a permission dialog is
					// still open, is the caller's problem, not a server fault.
					return error(response, 400, caught instanceof Error ? caught.message : String(caught));
				}
				return json(response, 200, session.snapshot());
			}
			if (parts[4] === "model" && method === "PATCH") {
				const input = await body(request);
				if (typeof input.provider !== "string" || typeof input.modelId !== "string")
					return error(response, 400, "provider and modelId are required");
				await session.setModel(input.provider, input.modelId);
				return json(response, 200, session.snapshot());
			}
			if (parts[4] === "models" && parts[5] === "refresh" && parts.length === 6 && method === "POST") {
				// A provider added in settings must reach an open session's picker; the
				// session's catalog is otherwise frozen at creation.
				await session.refreshModels();
				return json(response, 200, session.snapshot());
			}
			if (parts[4] === "feedback" && parts[5] === "evidence" && parts.length === 6 && method === "GET") {
				// The consent dialog reads this before it offers to send anything: it
				// names the evidence the submission will carry, and prepares it once.
				try {
					return json(response, 200, await session.prepareFeedback());
				} catch (caught) {
					// Nothing configured is the caller's problem to show, not a fault.
					return error(response, 400, caught instanceof Error ? caught.message : String(caught));
				}
			}
			if (parts[4] === "feedback" && method === "POST") {
				const input = await body(request);
				if (input.sentiment !== "up" && input.sentiment !== "down") {
					return error(response, 400, "sentiment must be up or down");
				}
				if (typeof input.comment !== "string") return error(response, 400, "comment is required");
				const topic = typeof input.topic === "string" ? input.topic : undefined;
				// The dialog sends back the token of the evidence it displayed, so the
				// report cannot describe something the user was never shown.
				const token = typeof input.token === "string" ? input.token : undefined;
				const result = await session.submitFeedback({
					sentiment: input.sentiment,
					...(topic ? { topic } : {}),
					comment: input.comment,
					...(token ? { token } : {}),
				});
				// A rejected submission is the caller's problem to show, not a 500.
				return json(response, result.ok ? 200 : 400, result);
			}
			if (parts[4] === "fork" && method === "POST") {
				const input = await body(request);
				const entryId = typeof input.entryId === "string" ? input.entryId : undefined;
				try {
					const result = await session.fork(entryId);
					return json(response, 200, result);
				} catch (caught) {
					// A rejected fork is a bad request (wrong entry, nothing to fork
					// from), not a server fault.
					return error(response, 400, caught instanceof Error ? caught.message : String(caught));
				}
			}
			if (parts[4] === "goal" && method === "PATCH") {
				const input = await body(request);
				const action = input.action;
				if (
					action !== "start" &&
					action !== "pause" &&
					action !== "resume" &&
					action !== "edit" &&
					action !== "clear"
				) {
					return error(response, 400, "action must be start, pause, resume, edit or clear");
				}
				const objective = typeof input.objective === "string" ? input.objective : undefined;
				if ((action === "start" || action === "edit") && !objective?.trim()) {
					return error(response, 400, "objective is required to start or edit a goal");
				}
				// Slash commands, so fire-and-forget like /messages.
				void session
					.controlGoal(action, objective)
					.catch((caught) => session.publishError(caught instanceof Error ? caught.message : String(caught)));
				return json(response, 202, { ok: true });
			}
			if (parts[4] === "mode" && method === "PATCH") {
				const input = await body(request);
				const mode = input.mode;
				if (mode !== "goal" && mode !== "plan" && mode !== "ultraloop") {
					return error(response, 400, "mode must be goal, plan or ultraloop");
				}
				if (typeof input.enabled !== "boolean") return error(response, 400, "enabled is required");
				if (input.enabled && mode === "goal" && typeof input.goal !== "string") {
					return error(response, 400, "goal text is required to enable goal mode");
				}
				// Fire-and-forget like /messages: a slash command is a full agent turn
				// and can take seconds, and holding the request lets a client timeout
				// strand the session mid-turn.
				void session
					.setMode(mode, input.enabled, typeof input.goal === "string" ? input.goal : undefined)
					.catch((caught) => session.publishError(caught instanceof Error ? caught.message : String(caught)));
				return json(response, 202, { ok: true });
			}
			if (parts[4] === "thinking" && method === "PATCH") {
				const input = await body(request);
				if (typeof input.level !== "string") return error(response, 400, "level is required");
				try {
					session.setThinkingLevel(input.level);
				} catch (caught) {
					return error(response, 400, caught instanceof Error ? caught.message : String(caught));
				}
				return json(response, 200, session.snapshot());
			}
			if (parts[4] === "files" && method === "GET") {
				const listing = await listDirectory(session.cwd, url.searchParams.get("path") ?? "");
				return json(response, 200, { files: listing.entries, truncated: listing.truncated });
			}
			if (parts[4] === "file" && method === "GET") {
				return json(response, 200, await readWorkspaceFile(session.cwd, url.searchParams.get("path") ?? ""));
			}
		}
		return error(response, 404, "Not found");
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		error(response, message.startsWith("Session not found:") ? 404 : 500, message);
	}
});

// Import a local stepgo launcher's models before the first request, so the
// models page and the first session already see them. It runs once per
// installation and never rejects; listening must not wait on anything else.
void importLocalStepgoModels().finally(() => {
	// Connect in the background: listening must not wait on slow servers.
	resyncMcp();
	server.listen(port, bindHost, () => {
		console.log(
			formatStartupBanner({
				port: launchPort,
				token: auth.getLaunchToken(),
				version: resolveStepCodeVersion().value,
			}),
		);
		// Opt-in: the dev commands ask for it; desktop and the tests must not open a window.
		if (!shouldOpenBrowser(process.env, existsSync)) return;
		openBrowser(launchUrl(launchPort, auth.getLaunchToken()));
		recordBrowserOpened(process.env);
	});
});

// Installing signal handlers replaces Node's default exit, so shutdown must end
// the process itself: open SSE streams and keep-alive sockets would otherwise
// keep server.close() pending forever.
const shutdown = async (): Promise<void> => {
	server.close();
	server.closeAllConnections();
	let failed = false;
	try {
		const results = await Promise.allSettled([
			embeddedBrowser.close(),
			sitePreview.close(),
			terminals.stopAll(),
			voice.stopAll(),
			(async () => {
				try {
					// Stop live turns immediately; draining imports must not delay recording
					// their partial replies before Desktop's 5s SIGKILL. Both finish before
					// the session index is closed, including when either cleanup fails.
					const results = await Promise.allSettled([
						(async () => {
							try {
								await migrations?.close();
							} finally {
								await sessionImports.close();
							}
						})(),
						store.interruptAndClose({ graceMs: SHUTDOWN_TURN_GRACE_MS, reason: "host shutdown" }),
					]);
					for (const result of results) {
						if (result.status === "rejected") throw result.reason;
					}
				} finally {
					// Flush sessions before stopping their index, even if session teardown fails.
					// Sessions only release their MCP leases; the pool owns the server processes.
					await mcpWarmup.release();
					await Promise.all([sessionSearch.close(), closeStepMcpPool()]);
				}
			})(),
		]);
		for (const result of results) {
			if (result.status === "rejected") {
				failed = true;
				console.error("Web host shutdown failed:", result.reason);
			}
		}
	} finally {
		process.exit(failed ? 1 : 0);
	}
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
// A closed launching terminal sends SIGHUP; without this the host would exit without stopping its shells.
process.once("SIGHUP", () => void shutdown());
