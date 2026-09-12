import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { Context, DeferredHandle, Model, ProviderRequestOptions } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
const context: Context = { messages: [] };

const model: Model<"telemetry-test"> = {
	id: "model",
	name: "Model",
	api: "telemetry-test",
	provider: "telemetry-provider",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function completedStream(requestModel: Model<string>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			},
		});
	});
	return stream;
}

describe("ProviderRequestOptions.telemetryContext", () => {
	it("is inherited by every request option surface and simple-stream conversion", () => {
		const options = { telemetryContext } satisfies ProviderRequestOptions;
		expect(options.telemetryContext).toBe(telemetryContext);
		expect(buildBaseOptions(model, context, { telemetryContext }).telemetryContext).toBe(telemetryContext);
	});

	it("survives provider and Models stream/deferred dispatch", async () => {
		const observed: Array<TelemetryContext | undefined> = [];
		const handle: DeferredHandle = {
			provider: model.provider,
			modelId: model.id,
			api: model.api,
			id: "response",
		};
		const provider = createProvider({
			id: model.provider,
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: {
				stream: (requestModel, _context, options) => {
					observed.push(options?.telemetryContext);
					return completedStream(requestModel);
				},
				streamSimple: (requestModel, _context, options) => {
					observed.push(options?.telemetryContext);
					return completedStream(requestModel);
				},
				fetchDeferred: (requestModel, _handle, options) => {
					observed.push(options?.telemetryContext);
					return completedStream(requestModel);
				},
				cancelDeferred: async (_requestModel, _handle, options) => {
					observed.push(options?.telemetryContext);
				},
			},
		});

		await provider.stream(model, context, { telemetryContext }).result();
		await provider.streamSimple(model, context, { telemetryContext }).result();
		await provider.fetchDeferred!(model, handle, { telemetryContext }).result();
		await provider.cancelDeferred!(model, handle, { telemetryContext });

		const models = createModels();
		models.setProvider(provider);
		await models.stream(model, context, { telemetryContext }).result();
		await models.streamSimple(model, context, { telemetryContext }).result();
		await models.fetchDeferred(model, handle, { telemetryContext });
		await models.cancelDeferred(model, handle, { telemetryContext });

		expect(observed).toHaveLength(8);
		expect(observed.every((value) => value === telemetryContext)).toBe(true);
	});
});
