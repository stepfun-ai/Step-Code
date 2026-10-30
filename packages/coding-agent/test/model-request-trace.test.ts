import type { Api, Model } from "@step-harness/providers";
import { describe, expect, it, vi } from "vitest";
import {
	createModelRequestTraceCapture,
	type ModelRequestResponse,
	type ModelRequestTrace,
	readResponseTraceId,
} from "../src/core/model-request-observer.ts";

const model = {
	id: "deepseek-v4.1-flash-api",
	provider: "internal-gateway",
	api: "anthropic-messages",
	baseUrl: "https://gateway.example.test/v1",
} as Model<Api>;

describe("model request trace capture", () => {
	it("reads the gateway trace id regardless of header case", () => {
		expect(readResponseTraceId({ "x-trace-id": " a5f244fa5819b09ea2636d37611b7596 " })).toBe(
			"a5f244fa5819b09ea2636d37611b7596",
		);
		expect(readResponseTraceId({ "X-Trace-Id": "fc8e0193e63f9088cf594b55bbb4d21f" })).toBe(
			"fc8e0193e63f9088cf594b55bbb4d21f",
		);
		expect(readResponseTraceId({})).toBeUndefined();
		expect(readResponseTraceId({ "x-trace-id": "   " })).toBeUndefined();
		expect(readResponseTraceId({ "x-trace-id": "has space" })).toBeUndefined();
		expect(readResponseTraceId({ "x-trace-id": "a".repeat(129) })).toBeUndefined();
	});

	it("is absent when the observer listens for neither responses nor traces", () => {
		expect(createModelRequestTraceCapture(undefined, "session-1")).toBeUndefined();
		expect(createModelRequestTraceCapture({ onRequestCompleted: () => undefined }, "session-1")).toBeUndefined();
		expect(createModelRequestTraceCapture({ onModelResponse: () => undefined }, "session-1")).toBeDefined();
	});

	it("reports every response, and the ones that carry a trace id as traces, numbering attempts", () => {
		const traces: ModelRequestTrace[] = [];
		const responses: ModelRequestResponse[] = [];
		const capture = createModelRequestTraceCapture(
			{
				onTraceId: (trace) => void traces.push(trace),
				onModelResponse: (response) => void responses.push(response),
			},
			"session-1",
		);

		capture?.onErrorResponse({ status: 500, headers: { "x-trace-id": "first" } }, model);
		capture?.onErrorResponse({ status: 401, headers: {} }, model);
		capture?.onResponse({ status: 200, headers: { "x-trace-id": "final" } }, model);

		expect(traces).toEqual([
			{
				traceId: "first",
				sessionId: "session-1",
				provider: "internal-gateway",
				model: "deepseek-v4.1-flash-api",
				baseUrl: "https://gateway.example.test/v1",
				statusCode: 500,
				attempt: 1,
			},
			expect.objectContaining({ traceId: "final", statusCode: 200, attempt: 3 }),
		]);
		// A provider without trace ids (any third-party API) is still observed.
		expect(responses).toEqual([
			expect.objectContaining({ statusCode: 500, attempt: 1 }),
			{
				sessionId: "session-1",
				provider: "internal-gateway",
				model: "deepseek-v4.1-flash-api",
				baseUrl: "https://gateway.example.test/v1",
				statusCode: 401,
				attempt: 2,
			},
			expect.objectContaining({ statusCode: 200, attempt: 3 }),
		]);
		expect(responses.some((response) => "traceId" in response)).toBe(false);
	});

	it("ignores malformed responses from extension providers instead of failing the request", () => {
		const onTraceId = vi.fn();
		const onModelResponse = vi.fn();
		const capture = createModelRequestTraceCapture({ onTraceId, onModelResponse }, "session-1");
		const malformed = [
			{ status: 200 },
			{ status: 200, headers: null },
			{ status: 200, headers: { "x-trace-id": 42 } },
			{ status: 200, headers: { "X-Trace-Id": ["t1"] } },
			undefined,
		] as unknown as Parameters<NonNullable<typeof capture>["onResponse"]>[0][];
		for (const response of malformed) {
			expect(() => capture?.onResponse(response, model)).not.toThrow();
			expect(() => capture?.onErrorResponse(response, model)).not.toThrow();
		}
		expect(onTraceId).not.toHaveBeenCalled();
		expect(onModelResponse).toHaveBeenCalledTimes(malformed.length * 2);
		expect(onModelResponse).toHaveBeenLastCalledWith(expect.objectContaining({ statusCode: 0 }));
		expect(readResponseTraceId(undefined)).toBeUndefined();
		capture?.onResponse({ status: "200", headers: { "x-trace-id": "t9" } } as never, model);
		expect(onTraceId).toHaveBeenCalledWith(expect.objectContaining({ traceId: "t9", statusCode: 0 }));
	});

	it("never lets an observer failure reach the provider response path", async () => {
		const rejected = vi.fn(async () => {
			throw new Error("reporter down");
		});
		const thrown = vi.fn(() => {
			throw new Error("reporter broken");
		});

		expect(() =>
			createModelRequestTraceCapture({ onTraceId: rejected, onModelResponse: thrown }, "")?.onResponse(
				{ status: 200, headers: { "x-trace-id": "t1" } },
				model,
			),
		).not.toThrow();
		expect(() =>
			createModelRequestTraceCapture({ onTraceId: thrown, onModelResponse: rejected }, "")?.onResponse(
				{ status: 200, headers: { "x-trace-id": "t2" } },
				model,
			),
		).not.toThrow();
		await Promise.resolve();
		expect(rejected).toHaveBeenCalledTimes(2);
		expect(thrown).toHaveBeenCalledTimes(2);
	});
});
