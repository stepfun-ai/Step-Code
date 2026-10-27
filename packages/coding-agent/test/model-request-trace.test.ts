import type { Api, Model } from "@step-harness/providers";
import { describe, expect, it, vi } from "vitest";
import {
	createModelRequestTraceCapture,
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

	it("is absent when the observer does not listen for traces", () => {
		expect(createModelRequestTraceCapture(undefined, "session-1")).toBeUndefined();
		expect(createModelRequestTraceCapture({ onRequestCompleted: () => undefined }, "session-1")).toBeUndefined();
	});

	it("reports every response that carries a trace id, numbering attempts within one request", () => {
		const traces: ModelRequestTrace[] = [];
		const capture = createModelRequestTraceCapture({ onTraceId: (trace) => void traces.push(trace) }, "session-1");

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
	});

	it("never lets an observer failure reach the provider response path", async () => {
		const rejected = vi.fn(async () => {
			throw new Error("reporter down");
		});
		const thrown = vi.fn(() => {
			throw new Error("reporter broken");
		});

		expect(() =>
			createModelRequestTraceCapture({ onTraceId: rejected }, "")?.onResponse(
				{ status: 200, headers: { "x-trace-id": "t1" } },
				model,
			),
		).not.toThrow();
		expect(() =>
			createModelRequestTraceCapture({ onTraceId: thrown }, "")?.onResponse(
				{ status: 200, headers: { "x-trace-id": "t2" } },
				model,
			),
		).not.toThrow();
		await Promise.resolve();
		expect(rejected).toHaveBeenCalledOnce();
		expect(thrown).toHaveBeenCalledOnce();
	});
});
