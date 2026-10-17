import type { SessionManager } from "../session-manager.ts";
import type { SessionManagerFactory } from "../session-manager-factory.ts";
import type { SessionIndex } from "./types.ts";

type PersistedSink = Pick<SessionIndex, "notifyPersisted">;

/**
 * Forward a manager's file writes to the index. The listener only enqueues a
 * debounced sync, so a slow or degraded index never delays persistence.
 * Replaces any listener already set on the manager.
 */
export function attachSessionIndex(manager: SessionManager, index: PersistedSink): SessionManager {
	manager.setFilePersistedListener((event) => index.notifyPersisted(event));
	return manager;
}

/** Wrap a factory so every manager it creates, opens, or forks reports writes to the index. */
export function withSessionIndex(factory: SessionManagerFactory, index: PersistedSink): SessionManagerFactory {
	const attach = (manager: SessionManager): SessionManager => attachSessionIndex(manager, index);
	return {
		create: (cwd, sessionDir, options) => attach(factory.create(cwd, sessionDir, options)),
		open: (path, sessionDir, cwdOverride) => attach(factory.open(path, sessionDir, cwdOverride)),
		inMemory: (cwd, options) => factory.inMemory(cwd, options),
		forkFrom: (sourcePath, targetCwd, sessionDir, options) =>
			attach(factory.forkFrom(sourcePath, targetCwd, sessionDir, options)),
		continueRecent: (cwd, sessionDir) => attach(factory.continueRecent(cwd, sessionDir)),
		list: factory.list.bind(factory),
		listAll: factory.listAll.bind(factory),
	};
}
