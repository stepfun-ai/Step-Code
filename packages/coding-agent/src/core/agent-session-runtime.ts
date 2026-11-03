import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import type { SessionManager } from "./session-manager.ts";
import { nativeSessionManagerFactory, type SessionManagerFactory } from "./session-manager-factory.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Runtime host contract consumed by the mode layer.
 *
 * Keeping this contract structural lets a product facade (such as StepCode)
 * sit in front of pi without forking InteractiveMode, print mode, or RPC mode.
 * AgentSessionRuntime remains the implementation and lifecycle authority.
 */
export interface AgentSessionRuntimeHost {
	readonly services: AgentSessionServices;
	readonly session: AgentSession;
	readonly cwd: string;
	readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
	readonly modelFallbackMessage: string | undefined;
	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void;
	onSessionChange(listener: (session: AgentSession) => void): () => void;
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void;
	switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }>;
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;
	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }>;
	importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }>;
	dispose(): Promise<void>;
}

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime implements AgentSessionRuntimeHost {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private readonly sessionManagerFactory: SessionManagerFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private readonly sessionChangeListeners = new Set<(session: AgentSession) => void>();
	private replacementTail: Promise<void> = Promise.resolve();
	private lifecycleState: "active" | "disposing" | "disposed" = "active";
	private currentSessionDisposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
		_sessionManagerFactory: SessionManagerFactory = nativeSessionManagerFactory,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this.sessionManagerFactory = _sessionManagerFactory;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		if (this.lifecycleState !== "active") return;
		this.rebindSession = rebindSession;
	}

	/**
	 * Subscribe to session replacement without taking ownership of the runtime.
	 *
	 * Hosts such as StepCode use this to move their event subscription to
	 * the replacement session created by `/new`, `/resume`, or `/fork`. The
	 * listener is intentionally synchronous: the runtime's existing rebind hook
	 * remains the place for asynchronous UI teardown and setup.
	 */
	onSessionChange(listener: (session: AgentSession) => void): () => void {
		if (this.lifecycleState !== "active") return () => {};
		this.sessionChangeListeners.add(listener);
		return () => this.sessionChangeListeners.delete(listener);
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		if (this.lifecycleState !== "active") return;
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private assertActive(): void {
		if (this.lifecycleState !== "active") {
			throw new Error("Agent session runtime is disposed");
		}
	}

	/**
	 * Serialize session replacement operations. The mode layer can receive more
	 * than one lifecycle request before the first one has finished (RPC input is
	 * deliberately streamed), so replacement must be FIFO at the runtime boundary.
	 */
	private enqueueReplacement<T>(operation: () => Promise<T>): Promise<T> {
		this.assertActive();
		const queued = this.replacementTail.then(() => {
			this.assertActive();
			return operation();
		});
		this.replacementTail = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		const session = this._session;
		// Settle any active response first so the aborted turn (including tool
		// results) is persisted to the outgoing session before it is replaced.
		await session.abort();
		await emitSessionShutdownEvent(session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		this.beforeSessionInvalidate?.();
		session.dispose();
		if (this._session === session) this.currentSessionDisposed = true;
	}

	private apply(result: CreateAgentSessionRuntimeResult): boolean {
		if (this.lifecycleState !== "active") {
			// A replacement may finish creating after shutdown has started. It was
			// never exposed to the host, so dispose it directly instead of rebinding
			// a stopped UI or leaking its resources.
			result.session.dispose();
			return false;
		}
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
		this.currentSessionDisposed = false;
		for (const listener of [...this.sessionChangeListeners]) {
			try {
				listener(this._session);
			} catch {
				// A compatibility observer must not prevent the runtime from rebinding.
			}
		}
		return true;
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.lifecycleState !== "active") return;
		const session = this._session;
		if (this.rebindSession) {
			await this.rebindSession(session);
		}
		if (withSession && this.lifecycleState === "active" && this._session === session) {
			await withSession(session.createReplacedSessionContext());
		}
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		return this.enqueueReplacement(async () => {
			const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
			if (beforeResult.cancelled) {
				return beforeResult;
			}

			const previousSessionFile = this.session.sessionFile;
			const sessionManager = this.sessionManagerFactory.open(sessionPath, undefined, options?.cwdOverride);
			assertSessionCwdExists(sessionManager, this.cwd);
			await this.teardownCurrent("resume", sessionManager.getSessionFile());
			const applied = this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
					projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
				}),
			);
			if (!applied) return { cancelled: true };
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false };
		});
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		return this.enqueueReplacement(async () => {
			const beforeResult = await this.emitBeforeSwitch("new");
			if (beforeResult.cancelled) {
				return beforeResult;
			}

			const previousSessionFile = this.session.sessionFile;
			const sessionDir = this.session.sessionManager.getSessionDir();
			const sessionManager = this.session.sessionManager.isPersisted()
				? this.sessionManagerFactory.create(this.cwd, sessionDir)
				: this.sessionManagerFactory.inMemory(this.cwd);
			if (options?.parentSession) {
				sessionManager.newSession({ parentSession: options.parentSession });
			}

			await this.teardownCurrent("new", sessionManager.getSessionFile());
			const applied = this.apply(
				await this.createRuntime({
					cwd: this.cwd,
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
				}),
			);
			if (!applied) return { cancelled: true };
			if (options?.setup) {
				await options.setup(this.session.sessionManager);
				this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
			}
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false };
		});
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.enqueueReplacement(async () => {
			const position = options?.position ?? "before";
			const beforeResult = await this.emitBeforeFork(entryId, { position });
			if (beforeResult.cancelled) {
				return { cancelled: true };
			}
			let targetLeafId: string | null;
			let selectedText: string | undefined;

			const selectedEntry = this.session.sessionManager.getEntry(entryId);
			if (!selectedEntry) {
				throw new Error("Invalid entry ID for forking");
			}

			if (position === "at") {
				targetLeafId = selectedEntry.id;
			} else {
				if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
					throw new Error("Invalid entry ID for forking");
				}
				targetLeafId = selectedEntry.parentId;
				selectedText = extractUserMessageText(selectedEntry.message.content);
			}

			const previousSessionFile = this.session.sessionFile;
			if (this.session.sessionManager.isPersisted()) {
				const currentSessionFile = this.session.sessionFile;
				if (!currentSessionFile) {
					throw new Error("Persisted session is missing a session file");
				}
				const sessionDir = this.session.sessionManager.getSessionDir();
				if (!targetLeafId) {
					const sessionManager = this.sessionManagerFactory.create(this.cwd, sessionDir);
					sessionManager.newSession({ parentSession: currentSessionFile });
					await this.teardownCurrent("fork", sessionManager.getSessionFile());
					const applied = this.apply(
						await this.createRuntime({
							cwd: this.cwd,
							agentDir: this.services.agentDir,
							sessionManager,
							sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
						}),
					);
					if (!applied) return { cancelled: true, selectedText };
					await this.finishSessionReplacement(options?.withSession);
					return { cancelled: false, selectedText };
				}

				if (!existsSync(currentSessionFile)) {
					throw new Error(
						"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
					);
				}
				const sessionManager = this.sessionManagerFactory.open(currentSessionFile, sessionDir);
				const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
				if (!forkedSessionPath) {
					throw new Error("Failed to create forked session");
				}
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				const applied = this.apply(
					await this.createRuntime({
						cwd: sessionManager.getCwd(),
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				);
				if (!applied) return { cancelled: true, selectedText };
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			const sessionManager = this.session.sessionManager;
			if (!targetLeafId) {
				sessionManager.newSession({ parentSession: this.session.sessionFile });
			} else {
				sessionManager.createBranchedSession(targetLeafId);
			}
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			const applied = this.apply(
				await this.createRuntime({
					cwd: this.cwd,
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			);
			if (!applied) return { cancelled: true, selectedText };
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		});
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.enqueueReplacement(async () => {
			const resolvedPath = resolvePath(inputPath);
			if (!existsSync(resolvedPath)) {
				throw new SessionImportFileNotFoundError(resolvedPath);
			}

			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!existsSync(sessionDir)) {
				mkdirSync(sessionDir, { recursive: true });
			}

			const destinationPath = join(sessionDir, basename(resolvedPath));
			const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
			if (beforeResult.cancelled) {
				return beforeResult;
			}

			const previousSessionFile = this.session.sessionFile;
			if (resolve(destinationPath) !== resolvedPath) {
				copyFileSync(resolvedPath, destinationPath);
			}

			const sessionManager = this.sessionManagerFactory.open(destinationPath, sessionDir, cwdOverride);
			assertSessionCwdExists(sessionManager, this.cwd);
			await this.teardownCurrent("resume", sessionManager.getSessionFile());
			const applied = this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				}),
			);
			if (!applied) return { cancelled: true };
			await this.finishSessionReplacement();
			return { cancelled: false };
		});
	}

	async dispose(): Promise<void> {
		if (this.disposePromise) {
			await this.disposePromise;
			return;
		}

		this.lifecycleState = "disposing";
		this.sessionChangeListeners.clear();
		this.disposePromise = (async () => {
			// Let an already-running replacement finish so its newly-created
			// session is owned and disposed below. Queued replacements observe the
			// closing state and fail before touching the old session.
			await this.replacementTail;
			const session = this._session;
			try {
				if (!this.currentSessionDisposed) {
					await emitSessionShutdownEvent(session.extensionRunner, {
						type: "session_shutdown",
						reason: "quit",
					});
					this.beforeSessionInvalidate?.();
					session.dispose();
					this.currentSessionDisposed = true;
				}
			} finally {
				this.rebindSession = undefined;
				this.beforeSessionInvalidate = undefined;
				this.lifecycleState = "disposed";
			}
		})();
		await this.disposePromise;
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
		sessionManagerFactory?: SessionManagerFactory;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
		options.sessionManagerFactory,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
