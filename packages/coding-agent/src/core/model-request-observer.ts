import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type Usage,
} from "@step-harness/providers";

/** Wire outcome used by the Step-compatible model-request event. */
export type ModelRequestOutcome = "ok" | "http_error" | "transport_error";

/**
 * Provider identity and timing captured when a request is admitted.
 *
 * `baseUrl` is intentionally available only to the injected observer so it can
 * classify the endpoint. Reporters must not send it as telemetry: a custom
 * endpoint is identifying data, and the Step event schema carries only its
 * three-way classification.
 */
export interface ModelRequestStarted {
	readonly provider: string;
	readonly model: string;
	readonly api: string;
	readonly baseUrl: string;
	readonly streamed: boolean;
	readonly sessionId?: string;
	readonly startedAt: number;
}

/** Immutable, provider-neutral completion observation. */
export interface ModelRequestCompleted extends ModelRequestStarted {
	readonly completedAt: number;
	readonly durationMs: number;
	readonly ttftMs: number | null;
	readonly statusCode: number;
	readonly outcome: ModelRequestOutcome;
	readonly stopReason: AssistantMessage["stopReason"];
	readonly responseModel?: string;
	readonly responseId?: string;
	readonly usage: ModelRequestUsage;
	/** Error class only; the message and provider payload are deliberately absent. */
	readonly errorType?: string;
}

/** Usage fields safe for aggregation and useful to turn-level reporters. */
export interface ModelRequestUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly reasoning?: number;
}

/**
 * Minimal observer seam for product integrations.
 *
 * Both callbacks are best effort: the caller never awaits them and an observer
 * failure cannot alter provider streaming or agent-loop settlement.
 */
export interface ModelRequestObserver {
	onRequestStarted?(request: ModelRequestStarted): void | Promise<void>;
	onRequestCompleted?(request: ModelRequestCompleted): void | Promise<void>;
}

export interface ObserveModelRequestStreamOptions {
	/** Timestamp captured immediately before the provider stream is requested. */
	readonly startedAt?: number;
	/** Session identity forwarded to the observer, when available. */
	readonly sessionId?: string;
	/** Whether the admitted request used a streaming transport. Defaults to true. */
	readonly streamed?: boolean;
	/** Status captured by the provider's onResponse callback. */
	readonly getStatusCode?: () => number;
	/**
	 * Resolve the model actually dispatched by the provider.
	 *
	 * ModelRuntime may replace the configured model's base URL after auth is
	 * resolved. The callback is evaluated at completion so endpoint
	 * classification and provider/model dimensions describe the wire request,
	 * while the initial model remains available for admission failures.
	 */
	readonly getModel?: () => Model<Api>;
}

/** Options for a request that failed before a provider stream was returned. */
export type ObserveModelRequestFailureOptions = ObserveModelRequestStreamOptions;

/**
 * Report a synchronous provider admission failure.
 *
 * Most providers return an event stream and are handled by
 * {@link observeModelRequestStream}. A provider can still throw before it
 * creates that stream (invalid credentials, a malformed model, or a lazy
 * loader failure); keeping this path explicit prevents the legacy analytics
 * data from losing its completion event.
 */
export function observeModelRequestFailure(
	model: Model<Api>,
	observer: ModelRequestObserver | undefined,
	error: unknown,
	options: ObserveModelRequestFailureOptions = {},
): void {
	if (!observer) return;
	const startedAt = options.startedAt ?? Date.now();
	const started = createStartedRequest(model, options, startedAt);
	notifyStarted(observer, started);
	const completedAt = Date.now();
	const message = createSyntheticErrorMessage(model, error);
	const effectiveModel = readModel(model, options.getModel);
	notifyCompleted(observer, {
		...started,
		provider: effectiveModel.provider,
		model: effectiveModel.id,
		api: effectiveModel.api,
		baseUrl: effectiveModel.baseUrl,
		completedAt,
		durationMs: Math.max(0, completedAt - startedAt),
		ttftMs: null,
		statusCode: readStatusCode(options.getStatusCode),
		outcome: "transport_error",
		stopReason: message.stopReason,
		usage: copyUsage(message.usage),
		errorType: readErrorType(error),
	});
}

/**
 * Wrap a Pi assistant stream and report one request lifecycle.
 *
 * The wrapper forwards every source event in order and returns synchronously,
 * just like Pi's native stream functions. It only observes terminal state; no
 * payload, prompt, tool arguments, headers, or response body is retained.
 */
export function observeModelRequestStream(
	model: Model<Api>,
	source: AssistantMessageEventStream,
	observer: ModelRequestObserver | undefined,
	options: ObserveModelRequestStreamOptions = {},
): AssistantMessageEventStream {
	if (!observer) return source;

	const startedAt = options.startedAt ?? Date.now();
	const started = createStartedRequest(model, options, startedAt);
	notifyStarted(observer, started);

	// Always use Pi's public factory instead of cloning `source.constructor`.
	// ModelRuntime normally returns an AssistantMessageEventStream, but lazy and
	// extension providers are allowed to return subclasses or cross-realm
	// streams. A constructor cast can then throw, or silently lose the stream's
	// terminal semantics. The factory is the stable Pi contract.
	const target = createAssistantMessageEventStream();
	let firstEventAt: number | undefined;
	let finalMessage: AssistantMessage | undefined;
	let settled = false;

	const finish = (message: AssistantMessage, unexpectedError?: unknown): void => {
		if (settled) return;
		settled = true;
		const completedAt = Date.now();
		const statusCode = readStatusCode(options.getStatusCode);
		const effectiveModel = readModel(model, options.getModel);
		const completion: ModelRequestCompleted = {
			...started,
			provider: effectiveModel.provider,
			model: effectiveModel.id,
			api: effectiveModel.api,
			baseUrl: effectiveModel.baseUrl,
			completedAt,
			durationMs: Math.max(0, completedAt - startedAt),
			ttftMs: firstEventAt === undefined ? null : Math.max(0, firstEventAt - startedAt),
			statusCode,
			outcome: classifyOutcome(statusCode, message, unexpectedError),
			stopReason: message.stopReason,
			...(message.responseModel ? { responseModel: message.responseModel } : undefined),
			...(message.responseId ? { responseId: message.responseId } : undefined),
			usage: copyUsage(message.usage),
			...(unexpectedError ? { errorType: readErrorType(unexpectedError) } : undefined),
		};
		notifyCompleted(observer, completion);
	};

	void (async () => {
		try {
			for await (const event of source) {
				// TTFT follows the old transport definition: the first *stream*
				// event, not a terminal done/error marker. A provider that returns an
				// HTTP error without a body therefore reports null, rather than 0ms.
				if (isStreamProgressEvent(event)) firstEventAt ??= Date.now();
				if (event.type === "done") {
					finalMessage = event.message;
					// Resolve the observer before forwarding the terminal event. The
					// Pi stream resolves `result()` while `push(done)` is called, so
					// doing this after `target.push` lets callers observe a completed
					// request only on a later turn of the event loop.
					finish(finalMessage);
				}
				if (event.type === "error") {
					finalMessage = event.error;
					finish(finalMessage);
				}
				target.push(event);
			}

			// A conforming provider emits a terminal event. If an extension returns
			// an ended stream without one, settle the wrapper with a synthetic error
			// instead of leaving target.result() pending forever.
			if (!finalMessage) {
				finalMessage = createSyntheticErrorMessage(model, "Provider stream ended without a terminal event");
				finish(finalMessage);
				target.push({ type: "error", reason: "error", error: finalMessage });
			}
			target.end(finalMessage);
		} catch (error) {
			finalMessage ??= createSyntheticErrorMessage(model, error);
			finish(finalMessage, error);
			target.push({ type: "error", reason: "error", error: finalMessage });
			target.end(finalMessage);
		}
	})();

	return target;
}

function createStartedRequest(
	model: Model<Api>,
	options: ObserveModelRequestStreamOptions,
	startedAt: number,
): ModelRequestStarted {
	return {
		provider: model.provider,
		model: model.id,
		api: model.api,
		baseUrl: model.baseUrl,
		streamed: options.streamed ?? true,
		...(options.sessionId ? { sessionId: options.sessionId } : undefined),
		startedAt,
	};
}

function readModel(fallback: Model<Api>, getModel: (() => Model<Api>) | undefined): Model<Api> {
	if (!getModel) return fallback;
	try {
		const model = getModel();
		if (model && typeof model === "object" && typeof model.id === "string" && typeof model.baseUrl === "string") {
			return model;
		}
	} catch {
		// A diagnostic getter must never affect stream settlement.
	}
	return fallback;
}

function notifyStarted(observer: ModelRequestObserver, request: ModelRequestStarted): void {
	try {
		const result = observer.onRequestStarted?.(request);
		void Promise.resolve(result).catch(() => undefined);
	} catch {
		// Observability must never affect request admission.
	}
}

function notifyCompleted(observer: ModelRequestObserver, request: ModelRequestCompleted): void {
	try {
		const result = observer.onRequestCompleted?.(request);
		void Promise.resolve(result).catch(() => undefined);
	} catch {
		// Observability must never affect request settlement.
	}
}

function readStatusCode(read: (() => number) | undefined): number {
	if (!read) return 0;
	try {
		const value = read();
		return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
	} catch {
		return 0;
	}
}

function classifyOutcome(statusCode: number, message: AssistantMessage, unexpectedError: unknown): ModelRequestOutcome {
	// Fetch's `Response.ok` is true only for 2xx. Keep redirects and other
	// non-success statuses in the HTTP bucket as the legacy transport did.
	if (statusCode > 0 && (statusCode < 200 || statusCode >= 300)) return "http_error";
	if (unexpectedError || message.stopReason === "aborted" || message.stopReason === "error") return "transport_error";
	return "ok";
}

function isStreamProgressEvent(event: AssistantMessageEvent): boolean {
	// The transport-level definition is "first event in the stream". Count
	// every non-terminal event, including provider-specific end markers, so a
	// minimal extension that emits only one content event still gets a TTFT.
	return event.type !== "done" && event.type !== "error";
}

function copyUsage(usage: Usage): ModelRequestUsage {
	return {
		input: finiteOrZero(usage.input),
		output: finiteOrZero(usage.output),
		cacheRead: finiteOrZero(usage.cacheRead),
		cacheWrite: finiteOrZero(usage.cacheWrite),
		totalTokens: finiteOrZero(usage.totalTokens),
		...(usage.reasoning === undefined ? undefined : { reasoning: finiteOrZero(usage.reasoning) }),
	};
}

function finiteOrZero(value: number): number {
	return Number.isFinite(value) ? value : 0;
}

function createSyntheticErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function readErrorType(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code ?? error.name;
	}
	return typeof error;
}
