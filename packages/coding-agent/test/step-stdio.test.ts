import { describe, expect, test, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import {
	createPiHarnessEventBridge,
	encodeStepStdioFrame,
	type PiHarnessEvent,
	STEP_PROTOCOL_NAME,
	STEP_PROTOCOL_VERSION,
	type StepFrame,
	StepStdioFrameDecoder,
	StepStdioProtocolViolation,
} from "../src/step/stdio.ts";

function request(payload: unknown = { text: "hello" }): StepFrame {
	return {
		protocol: STEP_PROTOCOL_NAME,
		version: STEP_PROTOCOL_VERSION,
		kind: "request",
		id: "req-1",
		method: "query.input",
		payload: payload as StepFrame["payload"],
	};
}

function sessionStub(sessionId: string): {
	session: AgentSession;
	emit(event: AgentSessionEvent): void;
} {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		sessionId,
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
	} as unknown as AgentSession;
	return {
		session,
		emit(event) {
			for (const listener of [...listeners]) listener(event);
		},
	};
}

describe("Step stdio frame codec", () => {
	test("round-trips UTF-8 frames split at arbitrary byte boundaries", () => {
		const encoded = encodeStepStdioFrame(request({ text: "中文\nhello" }));
		const decoder = new StepStdioFrameDecoder();
		const frames: StepFrame[] = [];
		for (let index = 0; index < encoded.length; index += 1) {
			frames.push(...decoder.push(encoded.subarray(index, index + 1)));
		}
		expect(frames).toEqual([request({ text: "中文\nhello" })]);
	});

	test("decodes coalesced frames and rejects malformed input", () => {
		const decoder = new StepStdioFrameDecoder();
		const bytes = Buffer.concat([encodeStepStdioFrame(request()), encodeStepStdioFrame(request({ n: 2 }))]);
		expect(decoder.push(bytes)).toHaveLength(2);

		const invalid = Buffer.alloc(4);
		invalid.writeUInt32BE(3, 0);
		expect(() => decoder.push(Buffer.concat([invalid, Buffer.from("no!", "utf8")]))).toThrow(
			StepStdioProtocolViolation,
		);
	});

	test("rejects oversized and incomplete frames", () => {
		expect(() => encodeStepStdioFrame(request({ value: "x" }), 8)).toThrow(StepStdioProtocolViolation);

		const decoder = new StepStdioFrameDecoder();
		const encoded = encodeStepStdioFrame(request());
		decoder.push(encoded.subarray(0, encoded.length - 1));
		expect(() => decoder.end()).toThrow(StepStdioProtocolViolation);
	});
});

describe("pi AgentSession event bridge", () => {
	test("routes input commands to pi and emits JSON-safe ordered events", async () => {
		let listener: ((event: AgentSessionEvent) => void) | undefined;
		const session = {
			sessionId: "session-1",
			subscribe: vi.fn((next: (event: AgentSessionEvent) => void) => {
				listener = next;
				return () => {
					listener = undefined;
				};
			}),
			prompt: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
			followUp: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
		} as unknown as AgentSession;
		const events: PiHarnessEvent[] = [];
		const frames: StepFrame[] = [];
		const bridge = createPiHarnessEventBridge(session, {
			queryId: "query-1",
			onEvent: (event) => events.push(event),
			onFrame: (frame) => frames.push(frame),
		});

		await bridge.input("first");
		await bridge.input({ type: "steer", message: "steer me" });
		await bridge.input({ type: "follow_up", message: "later" });
		expect(session.prompt).toHaveBeenCalledWith("first", {
			images: undefined,
			streamingBehavior: undefined,
			source: "rpc",
		});
		expect(session.steer).toHaveBeenCalledWith("steer me", undefined);
		expect(session.followUp).toHaveBeenCalledWith("later", undefined);

		const circular: { self?: unknown; value: string } = { value: "ok" };
		circular.self = circular;
		listener?.({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "read",
			args: circular,
			partialResult: new Set(["chunk"]),
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "tool_execution_update",
			session_id: "session-1",
			sequence: 1,
			query_id: "query-1",
		});
		expect(JSON.stringify(events[0])).toContain("[Circular]");
		expect(frames[0]).toMatchObject({
			kind: "event",
			method: "harness.event",
			sequence: 1,
		});

		await bridge.close();
		expect(session.abort).toHaveBeenCalledTimes(1);
		expect(bridge.closed).toBe(true);
		await expect(bridge.input("after close")).rejects.toThrow("closed");
	});

	test("follows runtime session replacement without resetting the event sequence", async () => {
		const first = sessionStub("session-1");
		const second = sessionStub("session-2");
		let current = first.session;
		let onSessionChange: ((session: AgentSession) => void) | undefined;
		const removeSessionChange = vi.fn();
		const runtime = {
			get session() {
				return current;
			},
			onSessionChange(listener: (session: AgentSession) => void) {
				onSessionChange = listener;
				return removeSessionChange;
			},
		} as unknown as AgentSessionRuntime;

		const events: PiHarnessEvent[] = [];
		const bridge = createPiHarnessEventBridge(runtime);
		bridge.subscribe((event) => events.push(event));
		first.emit({ type: "session_info_changed", name: "first" });

		current = second.session;
		onSessionChange?.(second.session);
		first.emit({ type: "session_info_changed", name: "stale" });
		second.emit({ type: "session_info_changed", name: "second" });

		expect(events.map((event) => [event.session_id, event.sequence])).toEqual([
			["session-1", 1],
			["session-2", 2],
		]);
		expect(bridge.sessionId).toBe("session-2");

		await bridge.input("after replacement");
		expect(second.session.prompt).toHaveBeenCalledWith("after replacement", {
			images: undefined,
			streamingBehavior: undefined,
			source: "rpc",
		});
		expect(first.session.prompt).not.toHaveBeenCalled();

		await bridge.close({ abort: false });
		expect(removeSessionChange).toHaveBeenCalledTimes(1);
	});
});
