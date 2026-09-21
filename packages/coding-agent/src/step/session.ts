/**
 * Step's session boundary over Pi's native SessionManager.
 *
 * The session file format, tree semantics, and lifecycle remain entirely
 * owned by Pi.  This adapter only chooses the Step storage root when a host
 * creates a session without an explicit Pi SessionManager.
 */

import type { Dirent } from "node:fs";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import {
	getDefaultSessionDir,
	type NewSessionOptions,
	parseSessionEntries,
	type SessionHeader,
	type SessionInfo,
	type SessionListProgress,
	SessionManager,
} from "../core/session-manager.ts";
import type { SessionManagerFactory } from "../core/session-manager-factory.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { getStepSessionDirOverride, LEGACY_RENAMED_CONFIG_DIR, resolveStepAgentDir } from "./environment.ts";

/** Metadata kept outside the native Pi manager. */
interface StepSessionManagerMetadata {
	agentDir: string;
	defaultSessionDir: string;
}

/** SessionManager's constructor is private, so Step decorates it with Proxy. */
const stepSessionManagerMetadata = new WeakMap<object, StepSessionManagerMetadata>();
const stepSessionManagerWrappers = new WeakMap<SessionManager, SessionManager>();

export interface StepSessionManagerOptions {
	/** Global Step agent directory. Defaults to `~/.stepcode/agent`. */
	agentDir?: string;
	/**
	 * Explicit session directory. When omitted, Pi's per-cwd encoded directory
	 * is created below the Step agent directory.
	 */
	sessionDir?: string;
	/** Options for the newly-created Pi session. */
	newSession?: NewSessionOptions;
}

export interface StepSessionQueryOptions {
	/** Global Step agent directory. Defaults to the StepCode directory. */
	agentDir?: string;
	/** Explicit session directory. When omitted, Pi's per-cwd directory is used. */
	sessionDir?: string;
	/** Base directory for a relative sessionDir. Defaults to the process cwd. */
	cwd?: string;
	/** Recursively scan Pi's per-cwd directories below the Step sessions root. */
	recursive?: boolean;
	onProgress?: SessionListProgress;
}

export interface StepOpenSessionOptions {
	/** Session directory used for subsequent /new and /branch operations. */
	sessionDir?: string;
	/** Global Step agent directory used when sessionDir is omitted. */
	agentDir?: string;
	/** Target cwd used to derive the Step session directory. */
	cwd?: string;
	cwdOverride?: string;
}

/** Options accepted by the Step static session facade. */
export type StepSessionPathOptions = Omit<StepSessionManagerOptions, "newSession">;

export interface StepSessionManagerWrapOptions {
	/** Global Step agent directory used for default-session comparisons. */
	agentDir?: string;
}

/**
 * Static surface that mirrors Pi's SessionManager while resolving every
 * implicit storage path through the Step namespace.  The returned instances
 * are still Pi SessionManager objects, so the session format and lifecycle
 * remain entirely Pi-owned.
 */
export interface StepSessionManagerFacade {
	create(cwd: string, options?: StepSessionManagerOptions): SessionManager;
	create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
	open(path: string, options?: StepOpenSessionOptions): SessionManager;
	open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
	continueRecent(cwd: string, options?: StepSessionPathOptions): SessionManager;
	continueRecent(cwd: string, sessionDir?: string): SessionManager;
	inMemory(cwd?: string, options?: NewSessionOptions): SessionManager;
	forkFrom(sourcePath: string, targetCwd: string, options?: StepSessionManagerOptions): SessionManager;
	forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
	list(cwd: string, options?: StepSessionQueryOptions): Promise<SessionInfo[]>;
	list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	listAll(options?: StepSessionQueryOptions): Promise<SessionInfo[]>;
	listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	listAll(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
}

function resolveAgentDir(agentDir?: string): string {
	return resolvePath(agentDir?.trim() || resolveStepAgentDir());
}

/** Compute Pi's encoded default directory without creating it. */
function getStepDefaultSessionDirPath(cwd: string, agentDir: string): string {
	const resolvedCwd = resolvePath(cwd);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
	return join(resolvePath(agentDir), "sessions", safePath);
}

/**
 * Decorate a native Pi SessionManager with Step's storage-root semantics.
 * The returned object remains `instanceof SessionManager`; all methods are
 * forwarded unchanged except `usesDefaultSessionDir()`.
 */
export function wrapStepSessionManager(
	manager: SessionManager,
	options: StepSessionManagerWrapOptions = {},
): SessionManager {
	if (stepSessionManagerMetadata.has(manager)) return manager;
	const previousWrapper = stepSessionManagerWrappers.get(manager);
	if (previousWrapper) return previousWrapper;

	const agentDir = resolveAgentDir(options.agentDir);
	const metadata: StepSessionManagerMetadata = {
		agentDir,
		defaultSessionDir: getStepDefaultSessionDirPath(manager.getCwd(), agentDir),
	};
	const wrapped = new Proxy(manager, {
		get(target, property, receiver) {
			if (property === "usesDefaultSessionDir") {
				return () => resolvePath(target.getSessionDir()) === metadata.defaultSessionDir;
			}
			return Reflect.get(target, property, receiver);
		},
	});
	stepSessionManagerMetadata.set(wrapped, metadata);
	stepSessionManagerWrappers.set(manager, wrapped);
	return wrapped;
}

/** Return whether a manager has already been decorated by Step. */
export function isStepSessionManager(manager: SessionManager): boolean {
	return stepSessionManagerMetadata.has(manager);
}

/** Resolve an explicit/custom session directory relative to a cwd. */
function resolveConfiguredSessionDir(cwd: string, sessionDir?: string, agentDir?: string): string | undefined {
	// An explicit agentDir is an instance boundary. Do not let a process-global
	// STEP_* session override (or a stale parent-shell value) redirect a caller
	// that deliberately supplied its own root.
	const configured = sessionDir?.trim() || (agentDir === undefined ? getStepSessionDirOverride() : undefined);
	return configured === undefined ? undefined : resolvePath(configured, resolvePath(cwd));
}

/** Return true when a path is inside a root, without treating sibling prefixes as children. */
function isPathInside(root: string, target: string): boolean {
	const relativePath = relative(resolvePath(root), resolvePath(target));
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * Explicitly selected legacy Pi session paths are read through the Step
 * namespace.  We keep arbitrary external paths working as Pi does, but never
 * let a Step resume operation append to a Pi or legacy StepCode session file.
 */
function isLegacyPiSessionPath(sessionPath: string): boolean {
	const resolvedPath = resolvePath(sessionPath);
	const inspectedPath = existsSync(resolvedPath) ? canonicalizePath(resolvedPath) : resolvedPath;
	return inspectedPath.split(/[\\/]/u).some((segment) => segment === ".pi" || segment === LEGACY_RENAMED_CONFIG_DIR);
}

function readSessionHeaderCwd(sessionPath: string): string | undefined {
	if (!existsSync(sessionPath)) return undefined;
	try {
		const entries = parseSessionEntries(readFileSync(sessionPath, "utf8"));
		const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
		return header?.cwd?.trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Copy a legacy Pi session into the Step per-cwd directory before opening it.
 * Native SessionManager.open() may rewrite/mutate the opened file, so merely
 * passing a Step `sessionDir` is insufficient: the session file itself must be
 * relocated first.
 */
function relocateLegacyPiSession(
	sessionPath: string,
	options: StepOpenSessionOptions,
	agentDir: string,
): { path: string; sessionDir: string } {
	const sourcePath = resolvePath(sessionPath);
	const cwd = resolvePath(options.cwdOverride ?? readSessionHeaderCwd(sourcePath) ?? options.cwd ?? process.cwd());
	const sessionDir = resolveStepSessionDir(cwd, {
		agentDir,
		sessionDir: options.sessionDir,
	});
	const sourceExists = existsSync(sourcePath);
	if (!sourceExists) {
		// Preserve the useful `--session <new-path>` behavior while ensuring a
		// legacy-namespaced path is created under Step's root instead.
		const targetPath = join(sessionDir, basename(sourcePath));
		return { path: targetPath, sessionDir };
	}

	mkdirSync(sessionDir, { recursive: true });
	let targetPath = join(sessionDir, basename(sourcePath));
	if (resolvePath(targetPath) === sourcePath) return { path: sourcePath, sessionDir };
	if (existsSync(targetPath)) {
		// Avoid clobbering an unrelated Step session with the same basename. The
		// suffix is intentionally deterministic for one process invocation.
		targetPath = join(sessionDir, `${basename(sourcePath, ".jsonl")}-imported-${process.pid}.jsonl`);
	}
	if (!existsSync(targetPath)) copyFileSync(sourcePath, targetPath);
	return { path: targetPath, sessionDir };
}

/** Resolve the Step per-project directory used by Pi's native session layout. */
function resolveStepSessionDir(cwd: string, options: StepSessionPathOptions = {}): string {
	const resolvedCwd = resolvePath(cwd);
	const configured = resolveConfiguredSessionDir(resolvedCwd, options.sessionDir, options.agentDir);
	return configured ?? getStepDefaultSessionDir(resolvedCwd, resolveAgentDir(options.agentDir));
}

/** Resolve the root scanned by Pi's listAll implementation. */
function resolveStepSessionRoot(options: StepSessionQueryOptions = {}): string {
	const configured =
		options.sessionDir?.trim() || (options.agentDir === undefined ? getStepSessionDirOverride() : undefined);
	if (configured !== undefined) {
		return resolvePath(configured, resolvePath(options.cwd ?? process.cwd()));
	}
	return join(resolveAgentDir(options.agentDir), "sessions");
}

/**
 * Pi's no-argument listAll scans one project directory per child of its
 * sessions root, while listAll(explicitDir) scans only files directly in that
 * directory. Preserve both behaviors in the Step facade without changing Pi.
 */
async function listStepSessionRoot(root: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const directories = entries
		.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
		.map((entry) => join(root, entry.name));
	if (directories.length === 0) return [];

	const lists = await Promise.all(directories.map((directory) => SessionManager.listAll(directory, onProgress)));
	return lists.flat().sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Resolve Pi's native per-cwd session directory under Step's agent root. */
export function getStepDefaultSessionDir(cwd: string, agentDir?: string): string {
	return getDefaultSessionDir(resolvePath(cwd), resolveAgentDir(agentDir));
}

/** Create a Pi SessionManager rooted in Step's storage namespace. */
export function createStepSessionManager(cwd: string, options?: StepSessionManagerOptions): SessionManager;
export function createStepSessionManager(
	cwd: string,
	sessionDir?: string,
	newSession?: NewSessionOptions,
): SessionManager;
export function createStepSessionManager(
	cwd: string,
	optionsOrSessionDir: StepSessionManagerOptions | string | undefined = {},
	newSession?: NewSessionOptions,
): SessionManager {
	const resolvedCwd = resolvePath(cwd);
	const options: StepSessionManagerOptions =
		typeof optionsOrSessionDir === "string"
			? { sessionDir: optionsOrSessionDir, newSession }
			: { ...(optionsOrSessionDir ?? {}), ...(newSession ? { newSession } : undefined) };
	const sessionDir = resolveStepSessionDir(resolvedCwd, options);
	return wrapStepSessionManager(SessionManager.create(resolvedCwd, sessionDir, options.newSession), {
		agentDir: options.agentDir,
	});
}

/**
 * Bind Pi's session operations to one Step agent root. Runtime replacement
 * flows keep Pi's static-method shape while never consulting a process-global
 * Pi storage directory after the initial session is created.
 */
export function createStepSessionManagerFactory(agentDir?: string): SessionManagerFactory {
	const fixedAgentDir = resolveAgentDir(agentDir);
	return {
		create: (cwd, sessionDir, options) =>
			createStepSessionManager(cwd, { agentDir: fixedAgentDir, sessionDir, newSession: options }),
		open: (path, sessionDir, cwdOverride) =>
			openStepSession(path, { agentDir: fixedAgentDir, sessionDir, cwdOverride }),
		inMemory: (cwd, options) =>
			wrapStepSessionManager(SessionManager.inMemory(resolvePath(cwd ?? process.cwd()), options), {
				agentDir: fixedAgentDir,
			}),
		forkFrom: (sourcePath, targetCwd, sessionDir, options) =>
			forkStepSession(sourcePath, targetCwd, {
				agentDir: fixedAgentDir,
				sessionDir,
				newSession: options,
			}),
		continueRecent: (cwd, sessionDir) => continueStepSession(cwd, { agentDir: fixedAgentDir, sessionDir }),
		list: (cwd, sessionDir, onProgress) => listStepSessions(cwd, { agentDir: fixedAgentDir, sessionDir, onProgress }),
		listAll: (sessionDirOrProgress?: string | SessionListProgress, onProgress?: SessionListProgress) =>
			typeof sessionDirOrProgress === "function"
				? listAllStepSessions({ agentDir: fixedAgentDir, onProgress: sessionDirOrProgress })
				: listAllStepSessions({ agentDir: fixedAgentDir, sessionDir: sessionDirOrProgress, onProgress }),
	};
}

/** List sessions for one cwd using Pi's native session scanner. */
export function listStepSessions(cwd: string, options?: StepSessionQueryOptions): Promise<SessionInfo[]>;
export function listStepSessions(
	cwd: string,
	sessionDir?: string,
	onProgress?: SessionListProgress,
): Promise<SessionInfo[]>;
export function listStepSessions(
	cwd: string,
	optionsOrSessionDir: StepSessionQueryOptions | string | undefined = {},
	onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
	const options: StepSessionQueryOptions =
		typeof optionsOrSessionDir === "string"
			? { sessionDir: optionsOrSessionDir, onProgress }
			: { ...(optionsOrSessionDir ?? {}), ...(onProgress ? { onProgress } : undefined) };
	const sessionDir = resolveStepSessionDir(cwd, options);
	return SessionManager.list(resolvePath(cwd), sessionDir, options.onProgress);
}

/** List all Step sessions below one agent root without consulting Pi's default root. */
export function listAllStepSessions(options?: StepSessionQueryOptions): Promise<SessionInfo[]>;
export function listAllStepSessions(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
export function listAllStepSessions(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
export function listAllStepSessions(
	optionsOrSessionDirOrProgress: StepSessionQueryOptions | string | SessionListProgress | undefined = {},
	onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
	const options: StepSessionQueryOptions =
		typeof optionsOrSessionDirOrProgress === "string"
			? { sessionDir: optionsOrSessionDirOrProgress, onProgress }
			: typeof optionsOrSessionDirOrProgress === "function"
				? { onProgress: optionsOrSessionDirOrProgress }
				: { ...(optionsOrSessionDirOrProgress ?? {}), ...(onProgress ? { onProgress } : undefined) };
	const root = resolveStepSessionRoot(options);
	const defaultRoot = join(resolveAgentDir(options.agentDir), "sessions");
	const isNativeStepRoot = resolvePath(root) === resolvePath(defaultRoot);
	return options.recursive === true || (options.recursive !== false && isNativeStepRoot)
		? listStepSessionRoot(root, options.onProgress)
		: SessionManager.listAll(root, options.onProgress);
}

/** Continue the most recent session for a cwd in Step's native per-cwd layout. */
export function continueStepSession(cwd: string, options?: StepSessionPathOptions): SessionManager;
export function continueStepSession(cwd: string, sessionDir?: string): SessionManager;
export function continueStepSession(
	cwd: string,
	optionsOrSessionDir: StepSessionPathOptions | string | undefined = {},
): SessionManager {
	const options: StepSessionPathOptions =
		typeof optionsOrSessionDir === "string" ? { sessionDir: optionsOrSessionDir } : (optionsOrSessionDir ?? {});
	const sessionDir = resolveStepSessionDir(cwd, options);
	return wrapStepSessionManager(SessionManager.continueRecent(resolvePath(cwd), sessionDir), {
		agentDir: options.agentDir,
	});
}

/** Open a session while preserving Pi's native branch and replacement behavior. */
export function openStepSession(path: string, options?: StepOpenSessionOptions): SessionManager;
export function openStepSession(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
export function openStepSession(
	path: string,
	optionsOrSessionDir: StepOpenSessionOptions | string | undefined = {},
	cwdOverride?: string,
): SessionManager {
	const options: StepOpenSessionOptions =
		typeof optionsOrSessionDir === "string"
			? { sessionDir: optionsOrSessionDir, cwdOverride }
			: { ...(optionsOrSessionDir ?? {}), ...(cwdOverride !== undefined ? { cwdOverride } : undefined) };
	const agentDir = resolveAgentDir(options.agentDir);
	const resolvedPath = resolvePath(path);
	const inspectedPath = existsSync(resolvedPath) ? canonicalizePath(resolvedPath) : resolvedPath;
	if (isLegacyPiSessionPath(resolvedPath) && !isPathInside(agentDir, inspectedPath)) {
		const relocated = relocateLegacyPiSession(resolvedPath, options, agentDir);
		return wrapStepSessionManager(SessionManager.open(relocated.path, relocated.sessionDir, options.cwdOverride), {
			agentDir,
		});
	}
	// Pi derives an opened manager's follow-up directory from the JSONL parent
	// when no explicit sessionDir is supplied. Preserve that behavior so opening
	// a session from another workspace does not silently relocate its branches.
	const configuredSessionDir =
		options.sessionDir !== undefined
			? resolveConfiguredSessionDir(
					options.cwdOverride ?? options.cwd ?? process.cwd(),
					options.sessionDir,
					options.agentDir,
				)
			: undefined;
	return wrapStepSessionManager(SessionManager.open(resolvedPath, configuredSessionDir, options.cwdOverride), {
		agentDir,
	});
}

/** Fork a session into Step's per-cwd storage namespace. */
export function forkStepSession(
	sourcePath: string,
	targetCwd: string,
	options?: StepSessionManagerOptions,
): SessionManager;
export function forkStepSession(
	sourcePath: string,
	targetCwd: string,
	sessionDir?: string,
	newSession?: NewSessionOptions,
): SessionManager;
export function forkStepSession(
	sourcePath: string,
	targetCwd: string,
	optionsOrSessionDir: StepSessionManagerOptions | string | undefined = {},
	newSession?: NewSessionOptions,
): SessionManager {
	const options: StepSessionManagerOptions =
		typeof optionsOrSessionDir === "string"
			? { sessionDir: optionsOrSessionDir, newSession }
			: { ...(optionsOrSessionDir ?? {}), ...(newSession ? { newSession } : undefined) };
	const sessionDir = resolveStepSessionDir(targetCwd, options);
	return wrapStepSessionManager(
		SessionManager.forkFrom(resolvePath(sourcePath), resolvePath(targetCwd), sessionDir, options.newSession),
		{ agentDir: options.agentDir },
	);
}

/** Pi-shaped static facade for hosts that should never consult `.pi`. */
export const StepSessionManager: StepSessionManagerFacade = {
	create: createStepSessionManager,
	open: openStepSession,
	continueRecent: continueStepSession,
	inMemory: (cwd = process.cwd(), options) =>
		wrapStepSessionManager(SessionManager.inMemory(resolvePath(cwd), options)),
	forkFrom: forkStepSession,
	list: listStepSessions,
	listAll: listAllStepSessions,
};
