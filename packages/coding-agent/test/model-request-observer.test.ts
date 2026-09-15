import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
} from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import {
	type ModelRequestCompleted,
	type ModelRequestObserver,
	type ModelRequestStarted,
	observeModelRequestFailure,
	observeModelRequestStream,
} from "../src/core/model-request-observer.ts";
import {
	classifyStepEndpoint,
	createStepModelRequestObserver,
	type StepModelRequestEventName,
	type StepTelemetryProperties,
} from "../src/step/telemetry.ts";

const model = {
	id: "step-3.7-flash",
	name: "Step 3.7 Flash",
	api: "openai-completions",
	provider: "step",
	baseUrl: "https://api.stepfun.com/step_plan/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} satisfies Model<Api>;

function message(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 10,
			output: 2,
			cacheRead: 3,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

async function consume(stream: ReturnType<typeof createAssistantMessageEventStream>): Promise<AssistantMessage> {
	for await (const _event of stream) {
		// Drain the stream before reading its settled result.
	}
	return stream.result();
}

describe("observeModelRequestStream", () => {
	it("reports a provider failure that happens before stream creation", () => {
		const completed: ModelRequestCompleted[] = [];
		observeModelRequestFailure(
			model,
			{
				onRequestCompleted: (request) => {
					completed.push(request);
				},
			},
			new Error("credentials unavailable"),
			{ startedAt: Date.now() - 5, getStatusCode: () => 401 },
		);

		expect(completed).toHaveLength(1);
		expect(completed[0]).toMatchObject({
			statusCode: 401,
			outcome: "transport_error",
			ttftMs: null,
			errorType: "Error",
		});
	});

	it("forwards events and reports the legacy completion dimensions", async () => {
		const source = createAssistantMessageEventStream();
		const started: ModelRequestStarted[] = [];
		const completed: ModelRequestCompleted[] = [];
		const observer: ModelRequestObserver = {
			onRequestStarted: (request) => {
				started.push(request);
			},
			onRequestCompleted: (request) => {
				completed.push(request);
			},
		};
		const wrapped = observeModelRequestStream(model, source, observer, {
			startedAt: Date.now() - 25,
			sessionId: "session-1",
			getStatusCode: () => 200,
		});

		source.push({ type: "start", partial: message("pending") });
		source.push({
			type: "text_start",
			contentIndex: 0,
			partial: message("pending"),
		});
		source.push({ type: "done", reason: "stop", message: message() });
		const final = await consume(wrapped);

		expect(final.stopReason).toBe("stop");
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({
			provider: "step",
			model: "step-3.7-flash",
			api: "openai-completions",
			streamed: true,
			sessionId: "session-1",
		});
		expect(completed).toHaveLength(1);
		expect(completed[0]).toMatchObject({
			provider: "step",
			model: "step-3.7-flash",
			statusCode: 200,
			outcome: "ok",
			streamed: true,
			stopReason: "stop",
			usage: { input: 10, output: 2, cacheRead: 3, totalTokens: 15 },
		});
		expect(completed[0]?.durationMs).toBeGreaterThanOrEqual(0);
		expect(completed[0]?.ttftMs).not.toBeNull();
	});

	it("classifies non-success responses as HTTP errors", async () => {
		const source = createAssistantMessageEventStream();
		const completed: ModelRequestCompleted[] = [];
		const wrapped = observeModelRequestStream(
			model,
			source,
			{
				onRequestCompleted: (request) => {
					completed.push(request);
				},
			},
			{ getStatusCode: () => 429 },
		);

		source.push({ type: "error", reason: "error", error: message("error") });
		await consume(wrapped);

		expect(completed[0]?.outcome).toBe("http_error");
		expect(completed[0]?.statusCode).toBe(429);
	});

	it("classifies redirects and other non-2xx statuses as HTTP errors", async () => {
		const source = createAssistantMessageEventStream();
		const completed: ModelRequestCompleted[] = [];
		const wrapped = observeModelRequestStream(
			model,
			source,
			{
				onRequestCompleted: (request) => {
					completed.push(request);
				},
			},
			{ getStatusCode: () => 302 },
		);

		source.push({ type: "done", reason: "stop", message: message() });
		await consume(wrapped);

		expect(completed[0]?.outcome).toBe("http_error");
		expect(completed[0]?.statusCode).toBe(302);
	});

	it("does not treat a terminal error marker as time to first token", async () => {
		const source = createAssistantMessageEventStream();
		const completed: ModelRequestCompleted[] = [];
		const wrapped = observeModelRequestStream(
			model,
			source,
			{
				onRequestCompleted: (request) => {
					completed.push(request);
				},
			},
			{ getStatusCode: () => 0 },
		);

		source.push({ type: "error", reason: "error", error: message("error") });
		await consume(wrapped);

		expect(completed).toHaveLength(1);
		expect(completed[0]?.ttftMs).toBeNull();
		expect(completed[0]?.outcome).toBe("transport_error");
	});

	it("counts a non-terminal content-end event as the first stream event", async () => {
		const source = createAssistantMessageEventStream();
		const completed: ModelRequestCompleted[] = [];
		const wrapped = observeModelRequestStream(
			model,
			source,
			{
				onRequestCompleted: (request) => {
					completed.push(request);
				},
			},
			{ startedAt: Date.now() - 10, getStatusCode: () => 200 },
		);

		source.push({
			type: "text_end",
			contentIndex: 0,
			content: "ok",
			partial: message("pending"),
		});
		source.push({ type: "done", reason: "stop", message: message() });
		await consume(wrapped);

		expect(completed[0]?.ttftMs).not.toBeNull();
	});

	it("swallows observer failures without changing stream settlement", async () => {
		const source = createAssistantMessageEventStream();
		const finalMessage = message();
		const wrapped = observeModelRequestStream(model, source, {
			onRequestStarted: () => {
				throw new Error("observer start failed");
			},
			onRequestCompleted: () => Promise.reject(new Error("observer completion failed")),
		});

		source.push({ type: "done", reason: "stop", message: finalMessage });
		await expect(consume(wrapped)).resolves.toMatchObject({
			stopReason: "stop",
		});
	});
});

describe("createStepModelRequestObserver", () => {
	it("maps completion to the old model_request_completed fields", () => {
		const events: Array<{
			event: StepModelRequestEventName;
			properties: StepTelemetryProperties;
		}> = [];
		const observer = createStepModelRequestObserver(
			{
				track: (event, properties) => {
					if (event === "model_request_completed") events.push({ event: "model_request_completed", properties });
				},
			},
			{ observerBaseUrls: ["https://api.stepfun.com/stepcliobserserver/v1"] },
		);
		const started: ModelRequestStarted = {
			provider: "step",
			model: "step-3.7-flash",
			api: "openai-completions",
			baseUrl: "https://api.stepfun.com/stepcliobserserver/v1",
			streamed: true,
			sessionId: "session-1",
			startedAt: 100,
		};
		const completed: ModelRequestCompleted = {
			...started,
			completedAt: 250,
			durationMs: 150,
			ttftMs: 20,
			statusCode: 200,
			outcome: "ok",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
			},
		};

		observer.onRequestStarted?.(started);
		observer.onRequestCompleted?.(completed);

		expect(events).toEqual([
			{
				event: "model_request_completed",
				properties: {
					provider: "step",
					model: "step-3.7-flash",
					duration_ms: 150,
					ttft_ms: 20,
					endpoint_kind: "platform",
					outcome: "ok",
					status_code: 200,
					streamed: true,
					routed_via_cloud_trace: true,
				},
			},
		]);
	});

	it("skips completions without a valid session trace", () => {
		const events: Array<{
			event: StepModelRequestEventName;
			properties: StepTelemetryProperties;
		}> = [];
		const observer = createStepModelRequestObserver({
			track: (event, properties) => {
				if (event === "model_request_completed") events.push({ event: "model_request_completed", properties });
			},
		});
		const started: ModelRequestStarted = {
			provider: "step",
			model: "step-3.7-flash",
			api: "openai-completions",
			baseUrl: "https://api.stepfun.com/step_plan/v1",
			streamed: true,
			startedAt: 0,
		};
		observer.onRequestCompleted?.({
			...started,
			completedAt: 1,
			durationMs: 1,
			ttftMs: null,
			statusCode: 0,
			outcome: "transport_error",
			stopReason: "error",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
			},
		});
		expect(events).toEqual([]);
	});

	it("classifies the provider-resolved endpoint on completion", () => {
		const source = createAssistantMessageEventStream();
		const completed: ModelRequestCompleted[] = [];
		const effectiveModel = {
			...model,
			id: "effective-model",
			baseUrl: "http://127.0.0.1:9000/v1",
		};
		const wrapped = observeModelRequestStream(
			model,
			source,
			{
				onRequestCompleted: (request) => {
					completed.push(request);
				},
			},
			{ sessionId: "session-2", getModel: () => effectiveModel },
		);
		source.push({ type: "done", reason: "stop", message: message() });
		return expect(consume(wrapped))
			.resolves.toBeDefined()
			.then(() => {
				expect(completed[0]).toMatchObject({
					provider: "step",
					model: "effective-model",
					baseUrl: "http://127.0.0.1:9000/v1",
				});
			});
	});

	it("classifies local and custom endpoints without exposing their URL", () => {
		expect(classifyStepEndpoint("http://127.0.0.1:9000/v1")).toBe("local");
		expect(classifyStepEndpoint("https://operator.example/v1")).toBe("custom");
		expect(classifyStepEndpoint("https://evil.stepfun.com/v1")).toBe("custom");
	});

	it("treats configured Step model hosts as platform endpoints", () => {
		expect(
			classifyStepEndpoint("https://staging.internal/v1/chat", {
				STEP_BASE_URL: "https://staging.internal/v1",
			}),
		).toBe("platform");
		// A generic trace allowlist is not a product endpoint declaration and
		// therefore must not change the endpoint-origin dimension.
		expect(
			classifyStepEndpoint("https://operator.example/v1/chat", {
				STEP_TRACE_HEADER_BASE_URLS: "https://operator.example/v1",
			}),
		).toBe("custom");
	});

	it("continues tracking when context or endpoint callbacks throw", () => {
		const events: StepTelemetryProperties[] = [];
		const observer = createStepModelRequestObserver(
			{
				setContext: () => {
					throw new Error("context unavailable");
				},
				track: (_event, properties) => {
					events.push(properties);
				},
			},
			{
				classifyEndpoint: () => {
					throw new Error("classifier unavailable");
				},
				isObserverRouted: () => {
					throw new Error("router unavailable");
				},
			},
		);

		observer.onRequestCompleted?.({
			...({
				provider: "step",
				model: "step-3.7-flash",
				api: "openai-completions",
				baseUrl: "https://api.stepfun.com/v1",
				streamed: true,
				sessionId: "session-3",
				startedAt: 0,
			} satisfies ModelRequestStarted),
			completedAt: 1,
			durationMs: 1,
			ttftMs: null,
			statusCode: 0,
			outcome: "transport_error",
			stopReason: "error",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		});

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ endpoint_kind: "custom", routed_via_cloud_trace: false });
	});
});
