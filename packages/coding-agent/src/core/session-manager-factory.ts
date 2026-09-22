import type { NewSessionOptions, SessionInfo, SessionListProgress, SessionManager } from "./session-manager.ts";
import { SessionManager as NativeSessionManager } from "./session-manager.ts";

/**
 * Pi-shaped session construction surface used by runtime replacement flows.
 * Products can bind the same operations to a different storage namespace while
 * keeping SessionManager itself, its file format, and its lifecycle semantics
 * owned by Pi.
 */
export interface SessionManagerFactory {
	create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
	open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
	inMemory(cwd?: string, options?: NewSessionOptions): SessionManager;
	forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
	continueRecent(cwd: string, sessionDir?: string): SessionManager;
	list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	listAll(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
}

/** Native Pi behavior used when no product storage wrapper is installed. */
export const nativeSessionManagerFactory: SessionManagerFactory = {
	create: (cwd, sessionDir, options) => NativeSessionManager.create(cwd, sessionDir, options),
	open: (path, sessionDir, cwdOverride) => NativeSessionManager.open(path, sessionDir, cwdOverride),
	inMemory: (cwd, options) => NativeSessionManager.inMemory(cwd, options),
	forkFrom: (sourcePath, targetCwd, sessionDir, options) =>
		NativeSessionManager.forkFrom(sourcePath, targetCwd, sessionDir, options),
	continueRecent: (cwd, sessionDir) => NativeSessionManager.continueRecent(cwd, sessionDir),
	list: (cwd, sessionDir, onProgress) => NativeSessionManager.list(cwd, sessionDir, onProgress),
	listAll: (sessionDirOrProgress?: string | SessionListProgress, onProgress?: SessionListProgress) =>
		typeof sessionDirOrProgress === "function"
			? NativeSessionManager.listAll(sessionDirOrProgress)
			: NativeSessionManager.listAll(sessionDirOrProgress, onProgress),
};
