import type { ThinkingLevel } from "@step-harness/agent-core";
import type { Api, ImageContent, Model, TextContent } from "@step-harness/providers";
import type { AgentSession, AgentSessionEventListener, PromptOptions } from "./core/agent-session.ts";
import type { AgentSessionRuntime, AgentSessionRuntimeHost } from "./core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./core/agent-session-services.ts";
import type { ProjectTrustContext, ReplacedSessionContext } from "./core/extensions/index.ts";
import type { SessionManager } from "./core/session-manager.ts";

/**
 * Stable Step-facing facade over pi's session runtime.
 *
 * It intentionally contains no scheduling or state machine of its own. Input,
 * queueing, persistence, compaction, and lifecycle remain owned by pi.
 */
export interface StepCode extends AgentSessionRuntimeHost {
	readonly runtime: AgentSessionRuntime;
	readonly session: AgentSession;
	readonly sessionId: string;
	readonly services: AgentSessionServices;
	readonly cwd: string;
	readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
	readonly modelFallbackMessage: string | undefined;
	input(text: string, options?: Pick<PromptOptions, "streamingBehavior" | "images">): Promise<void>;
	steer(text: string, images?: ImageContent[]): Promise<void>;
	followUp(text: string, images?: ImageContent[]): Promise<void>;
	inputContent(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void>;
	clearQueue(): { steering: string[]; followUp: string[] };
	interrupt(): Promise<void>;
	waitForIdle(): Promise<void>;
	setModel(model: Model<Api>): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): void;
	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void;
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void;
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;
	switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }>;
	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }>;
	importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }>;
	subscribe(listener: AgentSessionEventListener): () => void;
	onSessionChange(listener: (session: AgentSession) => void): () => void;
	dispose(): Promise<void>;
}

export function createStepCode(runtime: AgentSessionRuntime): StepCode {
	type Subscription = {
		listener: AgentSessionEventListener;
		unsubscribe: () => void;
	};

	const subscriptions = new Set<Subscription>();
	const sessionChangeSubscriptions = new Set<() => void>();
	let disposed = false;
	let disposePromise: Promise<void> | undefined;

	// AgentSessionRuntime replaces the concrete session for /new, /resume, and
	// /fork. Keep the Step-facing subscriptions attached to whichever session is
	// current; all execution and lifecycle decisions remain in pi.
	const rebindSubscriptions = (session: AgentSession): void => {
		if (disposed) return;
		for (const subscription of subscriptions) {
			subscription.unsubscribe();
			subscription.unsubscribe = session.subscribe(subscription.listener);
		}
	};

	const removeRuntimeListener = runtime.onSessionChange(rebindSubscriptions);
	const ensureOpen = (): void => {
		if (disposed) {
			throw new Error("stepcode runtime is disposed");
		}
	};

	return {
		runtime,
		get session() {
			return runtime.session;
		},
		get sessionId() {
			return runtime.session.sessionId;
		},
		get services() {
			return runtime.services;
		},
		get cwd() {
			return runtime.cwd;
		},
		get diagnostics() {
			return runtime.diagnostics;
		},
		get modelFallbackMessage() {
			return runtime.modelFallbackMessage;
		},
		input: (text, options) => {
			ensureOpen();
			// stepcode calls are external to the interactive TUI. Keep their
			// source stable so input extensions, auditing, and telemetry do not
			// depend on which convenience method the caller happened to use.
			return runtime.session.prompt(text, {
				images: options?.images,
				streamingBehavior: options?.streamingBehavior,
				source: "rpc",
			});
		},
		steer: (text, images) => {
			ensureOpen();
			return runtime.session.steer(text, images);
		},
		followUp: (text, images) => {
			ensureOpen();
			return runtime.session.followUp(text, images);
		},
		inputContent: (content, options) => {
			ensureOpen();
			// Reuse Pi's native content normalization and queue semantics. The
			// source override keeps this external boundary distinct from extension
			// calls, whose default remains source:"extension".
			return runtime.session.sendUserMessage(content, {
				deliverAs: options?.deliverAs,
				source: "rpc",
			});
		},
		clearQueue: () => {
			ensureOpen();
			return runtime.session.clearQueue();
		},
		interrupt: () => {
			ensureOpen();
			return runtime.session.abort();
		},
		waitForIdle: () => {
			ensureOpen();
			return runtime.session.waitForIdle();
		},
		setModel: (model) => {
			ensureOpen();
			return runtime.session.setModel(model);
		},
		setThinkingLevel: (level) => {
			ensureOpen();
			runtime.session.setThinkingLevel(level);
		},
		setRebindSession: (rebindSession) => {
			ensureOpen();
			runtime.setRebindSession(rebindSession);
		},
		setBeforeSessionInvalidate: (beforeSessionInvalidate) => {
			ensureOpen();
			runtime.setBeforeSessionInvalidate(beforeSessionInvalidate);
		},
		newSession: (options) => {
			ensureOpen();
			return runtime.newSession(options);
		},
		switchSession: (sessionPath, options) => {
			ensureOpen();
			return runtime.switchSession(sessionPath, options);
		},
		fork: (entryId, options) => {
			ensureOpen();
			return runtime.fork(entryId, options);
		},
		importFromJsonl: (inputPath, cwdOverride) => {
			ensureOpen();
			return runtime.importFromJsonl(inputPath, cwdOverride);
		},
		subscribe: (listener) => {
			if (disposed) return () => {};
			const subscription: Subscription = {
				listener,
				unsubscribe: runtime.session.subscribe(listener),
			};
			subscriptions.add(subscription);
			return () => {
				if (!subscriptions.delete(subscription)) return;
				subscription.unsubscribe();
			};
		},
		onSessionChange: (listener) => {
			if (disposed) return () => {};
			const remove = runtime.onSessionChange(listener);
			sessionChangeSubscriptions.add(remove);
			return () => {
				if (!sessionChangeSubscriptions.delete(remove)) return;
				remove();
			};
		},
		dispose: () => {
			if (disposePromise) return disposePromise;
			disposed = true;
			removeRuntimeListener();
			for (const remove of sessionChangeSubscriptions) {
				remove();
			}
			sessionChangeSubscriptions.clear();
			for (const subscription of subscriptions) {
				subscription.unsubscribe();
			}
			subscriptions.clear();
			// Share the runtime's asynchronous cleanup with every caller. This is
			// important for hosts that race signal handling and normal shutdown:
			// both callers must observe completion of the same disposal.
			disposePromise = runtime.dispose();
			return disposePromise;
		},
	};
}

export type StepCodeSession = AgentSession;
