import { describe, expect, it, vi } from "vitest";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolResultEvent,
	TurnEndEvent,
} from "../src/core/extensions/types.ts";
import {
	createStepLifecycleTelemetry,
	type StepTelemetryEventName,
	type StepTelemetryProperties,
	type StepTelemetryReporter,
} from "../src/step/telemetry.ts";

interface RecordedEvent {
	event: StepTelemetryEventName;
	properties: StepTelemetryProperties;
}

function createReporter() {
	const events: RecordedEvent[] = [];
	const contexts: Array<Record<string, string | undefined>> = [];
	const reporter: StepTelemetryReporter = {
		track: (event, properties) => {
			events.push({ event, properties });
		},
		setContext: (patch) => contexts.push({ ...patch }),
	};
	return { events, contexts, reporter };
}

function context(mode: ExtensionContext["mode"] = "tui", entries: unknown[] = []): ExtensionContext {
	return {
		mode,
		sessionManager: {
			getSessionId: () => "session-1",
			getEntries: () => entries,
		},
	} as unknown as ExtensionContext;
}

function assistant(usage: Record<string, number>, stopReason: "stop" | "error" | "aborted" = "stop") {
	return {
		role: "assistant",
		content: [],
		usage,
		stopReason,
	} as unknown as Extract<AgentEndEvent["messages"][number], { role: "assistant" }>;
}

describe("Step lifecycle telemetry", () => {
	it("projects session lifecycle fields and maps Pi UI modes", () => {
		const { reporter, events, contexts } = createReporter();
		const lifecycle = createStepLifecycleTelemetry(reporter, { agentMode: "normal" });
		const ctx = context("tui", [{}]);

		lifecycle.onSessionStart({ type: "session_start", reason: "startup" }, ctx);

		expect(contexts).toEqual([{ sessionId: "session-1" }]);
		expect(events).toEqual([
			{
				event: "session_started",
				properties: { resumed: true, agent_mode: "normal", ui_mode: "interactive" },
			},
		]);

		for (const [mode, expected] of [
			["rpc", "service"],
			["json", "json"],
			["print", "headless"],
		] as const) {
			lifecycle.onSessionStart({ type: "session_start", reason: "new" }, context(mode));
			expect(events.at(-1)?.properties.ui_mode).toBe(expected);
			expect(events.at(-1)?.properties.resumed).toBe(false);
		}
	});

	it("aggregates a multi-step agent run and uses execution timing for tools", () => {
		const { reporter, events } = createReporter();
		let now = 1_000;
		const lifecycle = createStepLifecycleTelemetry(reporter, { now: () => now });
		const ctx = context();
		const first = assistant({ input: 100, cacheRead: 4_000, output: 20 });
		const second = assistant({ input: 150, cacheWrite: 500, output: 30 });

		lifecycle.onAgentStart({ type: "agent_start" }, ctx);
		lifecycle.onTurnStart({ type: "turn_start", turnIndex: 0, timestamp: now }, ctx);
		lifecycle.onMessageEnd({ type: "message_end", message: first } as MessageEndEvent, ctx);
		lifecycle.onToolCall(
			{ type: "tool_call", toolCallId: "call-1", toolName: "run_command", input: {} } as ToolCallEvent,
			ctx,
		);
		now += 50;
		lifecycle.onToolExecutionStart(
			{
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "run_command",
				args: {},
			} as ToolExecutionStartEvent,
			ctx,
		);
		now += 120;
		lifecycle.onToolExecutionEnd(
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "run_command",
				result: {},
				isError: false,
			} as ToolExecutionEndEvent,
			ctx,
		);
		lifecycle.onTurnEnd(
			{
				type: "turn_end",
				turnIndex: 0,
				message: first,
				toolResults: [{ toolCallId: "call-1" }],
			} as unknown as TurnEndEvent,
			ctx,
		);

		now += 10;
		lifecycle.onTurnStart({ type: "turn_start", turnIndex: 1, timestamp: now }, ctx);
		now += 20;
		lifecycle.onTurnEnd(
			{ type: "turn_end", turnIndex: 1, message: second, toolResults: [] } as unknown as TurnEndEvent,
			ctx,
		);
		now += 800;
		lifecycle.onAgentEnd({ type: "agent_end", messages: [first, second] } as unknown as AgentEndEvent, ctx);

		expect(events).toEqual([
			{
				event: "tool_call_completed",
				properties: { tool_name: "run_command", outcome: "ok", error_code: null, duration_ms: 120 },
			},
			{
				event: "turn_completed",
				properties: {
					duration_ms: 1_000,
					step_count: 2,
					tool_call_count: 1,
					outcome: "ok",
					input_token_count: 250,
					cached_input_token_count: 4_500,
					output_token_count: 50,
				},
			},
		]);
	});

	it.each(["missing", "throws"])("clears prior reporter identity when the new session identity %s", (kind) => {
		const { reporter, contexts } = createReporter();
		const lifecycle = createStepLifecycleTelemetry(reporter);
		lifecycle.onSessionStart({ type: "session_start", reason: "startup" }, context());
		const next = {
			mode: "print",
			sessionManager: {
				getSessionId: () => {
					if (kind === "throws") throw new Error("stale session");
					return "";
				},
				getEntries: () => [],
			},
		} as unknown as ExtensionContext;
		lifecycle.onSessionStart({ type: "session_start", reason: "new" }, next);
		expect(contexts).toEqual([{ sessionId: "session-1" }, { sessionId: "" }]);
	});

	it("drops in-flight aggregates and reporter identity on reset", () => {
		const { reporter, contexts, events } = createReporter();
		const lifecycle = createStepLifecycleTelemetry(reporter);
		const ctx = context();
		lifecycle.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
		lifecycle.onAgentStart({ type: "agent_start" }, ctx);
		lifecycle.reset();
		lifecycle.onAgentEnd({ type: "agent_end", messages: [] }, ctx);
		expect(contexts).toEqual([{ sessionId: "session-1" }, { sessionId: "" }]);
		expect(events.map((event) => event.event)).toEqual(["session_started"]);
	});

	it("classifies denied and failed tools and reports permission decisions", () => {
		const { reporter, events } = createReporter();
		let now = 1_000;
		const lifecycle = createStepLifecycleTelemetry(reporter, { now: () => now });
		const ctx = context();

		lifecycle.onAgentStart({ type: "agent_start" }, ctx);
		lifecycle.recordPermissionDecision({ toolName: "run_command", action: "confirm", risk: "high", hazardous: true });
		lifecycle.recordPermissionApproval({ toolName: "run_command", decision: "deny", risk: "high" });
		lifecycle.onToolCall(
			{ type: "tool_call", toolCallId: "blocked", toolName: "run_command", input: {} } as ToolCallEvent,
			ctx,
		);
		lifecycle.markToolBlocked("blocked");
		now += 5;
		lifecycle.onToolResult(
			{
				type: "tool_result",
				toolCallId: "blocked",
				toolName: "run_command",
				input: {},
				content: [],
				isError: true,
			} as unknown as ToolResultEvent,
			ctx,
		);
		lifecycle.onToolCall(
			{ type: "tool_call", toolCallId: "failed", toolName: "read_file", input: {} } as ToolCallEvent,
			ctx,
		);
		now += 7;
		lifecycle.onToolExecutionEnd(
			{
				type: "tool_execution_end",
				toolCallId: "failed",
				toolName: "read_file",
				result: { code: "INVALID_ARGUMENTS" },
				isError: true,
			} as ToolExecutionEndEvent,
			ctx,
		);

		expect(events.slice(0, 4)).toEqual([
			{
				event: "permission_decision",
				properties: { tool_name: "run_command", mode: "confirm", risk: "high", hazardous: true },
			},
			{
				event: "permission_approval_result",
				properties: { tool_name: "run_command", decision: "deny", risk: "high" },
			},
			{
				event: "tool_call_completed",
				properties: {
					tool_name: "run_command",
					outcome: "denied",
					error_code: "PERMISSION_DENIED",
					duration_ms: 5,
				},
			},
			{
				event: "tool_call_completed",
				properties: { tool_name: "read_file", outcome: "error", error_code: "INVALID_ARGUMENTS", duration_ms: 7 },
			},
		]);
	});

	it("uses the legacy approval result vocabulary for accepted confirmations", () => {
		const { reporter, events } = createReporter();
		const lifecycle = createStepLifecycleTelemetry(reporter);
		lifecycle.recordPermissionApproval({ toolName: "write_file", decision: "allow", risk: "normal" });
		lifecycle.recordPermissionApproval({ toolName: "write_file", decision: "allow-always", risk: "normal" });
		lifecycle.recordPermissionApproval({ toolName: "write_file", decision: "denied", risk: "normal" });

		expect(events.map((event) => event.properties.decision)).toEqual(["allow-once", "allow-always", "deny"]);
	});

	it("registers Pi handlers, ignores orphan results, and isolates reporter failures", () => {
		const track = vi.fn(() => {
			throw new Error("telemetry sink unavailable");
		});
		const lifecycle = createStepLifecycleTelemetry({ track });
		const registered: string[] = [];
		const api = {
			on(event: string) {
				registered.push(event);
			},
		} as unknown as Pick<ExtensionAPI, "on">;
		lifecycle.register(api);
		expect(registered).toEqual([
			"session_start",
			"session_shutdown",
			"session_compact",
			"agent_start",
			"agent_end",
			"turn_start",
			"turn_end",
			"input",
			"message_end",
			"tool_call",
			"tool_result",
			"tool_execution_start",
			"tool_execution_end",
		]);

		const ctx = context();
		lifecycle.onToolResult(
			{
				type: "tool_result",
				toolCallId: "orphan",
				toolName: "read_file",
				input: {},
				content: [],
				isError: false,
			} as unknown as ToolResultEvent,
			ctx,
		);
		expect(track).not.toHaveBeenCalled();
		lifecycle.onAgentStart({ type: "agent_start" }, ctx);
		lifecycle.onAgentEnd({ type: "agent_end", messages: [] } as unknown as AgentEndEvent, ctx);
		expect(track).toHaveBeenCalledTimes(1);
	});

	it("records steering input and completed compaction with the active session", () => {
		const { reporter, events } = createReporter();
		const lifecycle = createStepLifecycleTelemetry(reporter);
		const ctx = context("tui", [
			{ type: "message", id: "old", parentId: null },
			{ type: "compaction", id: "compact", firstKeptEntryId: "kept" },
			{ type: "message", id: "kept", parentId: "compact" },
		]);

		lifecycle.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
		lifecycle.onAgentStart({ type: "agent_start" }, ctx);
		lifecycle.onTurnStart({ type: "turn_start", turnIndex: 2, timestamp: Date.now() }, ctx);
		lifecycle.onInput({ type: "input", text: "steer", source: "interactive", streamingBehavior: "steer" }, ctx);
		lifecycle.onSessionCompact(
			{
				type: "session_compact",
				compactionEntry: { type: "compaction", id: "compact", firstKeptEntryId: "kept" },
				fromExtension: false,
				reason: "threshold",
				willRetry: false,
			} as any,
			ctx,
		);

		expect(events.map((event) => event.event)).toEqual(["session_started", "turn_steered", "compaction_finished"]);
		expect(events[1]?.properties).toEqual({ step: 3, input_count: 1 });
		expect(events[2]?.properties).toEqual({
			mode: "threshold",
			// The compaction entry itself is a boundary, not an AgentMessage.
			summarized_message_count: 1,
			step: 3,
		});
	});

	it("supports explicit resume and mode resolvers without leaking callback errors", () => {
		const { reporter, events } = createReporter();
		const lifecycle = createStepLifecycleTelemetry(reporter, {
			agentMode: () => {
				throw new Error("stale context");
			},
			isResumed: () => {
				throw new Error("stale context");
			},
		});
		const event: SessionStartEvent = { type: "session_start", reason: "new" };
		lifecycle.onSessionStart(event, context("rpc"));
		expect(events.at(-1)?.properties).toEqual({ resumed: false, agent_mode: "unknown", ui_mode: "service" });
	});
});
