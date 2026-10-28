import type { Usage } from "@step-harness/providers";
import type { AgentSessionEvent } from "../core/agent-session.ts";
import { isEphemeralSessionEvent } from "../core/session-event-durability.ts";

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type ToJsonAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
	? WithoutPartial<T> & { id: string; toolName: string }
	: WithoutPartial<T>;

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type JsonMessageUpdateEvent = {
	type: "message_update";
	usage: Usage;
	assistantMessageEvent: ToJsonAssistantMessageEvent<MessageUpdateEvent["assistantMessageEvent"]>;
};

type ToolUpdateEvent = Extract<AgentSessionEvent, { type: "tool_execution_update" }>;
type JsonToolUpdateEvent = Omit<ToolUpdateEvent, "args"> & { args?: unknown };

type TurnEndEvent = Extract<AgentSessionEvent, { type: "turn_end" }>;

/**
 * A closed turn, without the messages it closes over.
 *
 * `message` and `toolResults` are not lost: each one already travelled as its
 * own `message_start`/`message_end`, and each tool result also as
 * `tool_execution_end`. What only this event says is *where the turn boundary
 * fell*, which the role and the count preserve.
 */
type JsonTurnEndEvent = {
	type: "turn_end";
	messageRole: TurnEndEvent["message"]["role"];
	toolResultCount: number;
};

/** A finished run, without the messages it just re-sent. */
type JsonAgentEndEvent = {
	type: "agent_end";
	willRetry: boolean;
	/**
	 * Length of the run's `messages` array — what this event used to carry.
	 *
	 * Informational, not a checksum: the loop can emit more `message_end` events
	 * than it lists here (a resampled tool-call leak, a throwing
	 * `shouldStopAfterTurn`), so a reader must not use it to detect truncation.
	 * A missing final message is visible as a message that never got its
	 * `message_end`.
	 */
	messageCount: number;
};

/**
 * Session event shape emitted by the JSON and RPC stdout protocols.
 *
 * Two kinds of repetition are removed. A frame is never written (its successor
 * carries the value), and a boundary event (`turn_end`, `agent_end`) is written
 * as its structure instead of carrying the messages it closes over — those
 * already travelled as their own `message_start`/`message_end`.
 *
 * What remains by design, per payload: a tool result on `tool_execution_end`
 * plus its own `message_start`/`message_end`, a user message on both of its
 * pair, and an assistant message's final payload once (its `message_start` is
 * the empty partial). Those are the begin/end pair and the execution outcome;
 * removing them would change event-sequence semantics rather than drop a
 * duplicate, so it is out of scope here.
 */
export type JsonAgentSessionEvent =
	| Exclude<AgentSessionEvent, { type: "message_update" | "tool_execution_update" | "turn_end" | "agent_end" }>
	| JsonMessageUpdateEvent
	| JsonToolUpdateEvent
	| JsonTurnEndEvent
	| JsonAgentEndEvent;

/** Options for the stdout projection. */
export interface ToJsonEventOptions {
	/**
	 * Include live frames (`message_update`, `tool_execution_update`).
	 *
	 * Off by default: a redirected stdout is a record of one run, and a frame is
	 * a cumulative snapshot of work in flight whose successor already states the
	 * value. A consumer that renders as it arrives — the subagent parent reading
	 * a child's pipe, a debugging session — passes this.
	 */
	includeLiveEvents?: boolean;
}

export const MAX_LIVE_UPDATE_BYTES = 256 * 1024;
const LIVE_TRUNCATION_MARKER = "[live output truncated]";
const MAX_LIVE_IDENTIFIER_CHARS = 200;

function boundedToolUpdate(event: ToolUpdateEvent): JsonToolUpdateEvent {
	if (Buffer.byteLength(JSON.stringify(event), "utf8") <= MAX_LIVE_UPDATE_BYTES) return event;
	const content: unknown = event.partialResult?.content;
	const text = Array.isArray(content)
		? content
				.filter(
					(part: unknown): part is { type: "text"; text: string } =>
						part !== null &&
						typeof part === "object" &&
						"type" in part &&
						part.type === "text" &&
						"text" in part &&
						typeof part.text === "string",
				)
				.map((part) => part.text)
				.join("\n")
		: "";
	// The start/end events own arguments and details. A live stdout frame must
	// not make a redirected log grow with accumulated state or an oversized id.
	const candidate = (tail: string): JsonToolUpdateEvent => ({
		type: "tool_execution_update",
		toolCallId: event.toolCallId.slice(0, MAX_LIVE_IDENTIFIER_CHARS),
		toolName: event.toolName.slice(0, MAX_LIVE_IDENTIFIER_CHARS),
		partialResult: { content: [{ type: "text", text: `${LIVE_TRUNCATION_MARKER}\n${tail}` }] },
	});
	let length = Math.min(text.length, MAX_LIVE_UPDATE_BYTES);
	let result = candidate(length > 0 ? text.slice(-length) : "");
	while (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_LIVE_UPDATE_BYTES && length > 0) {
		length = Math.floor(length / 2);
		// slice(-0) restores the entire output instead of reaching the floor.
		result = candidate(length > 0 ? text.slice(-length) : "");
	}
	return result;
}

function toJsonAssistantMessageEvent(
	event: MessageUpdateEvent["assistantMessageEvent"],
): JsonMessageUpdateEvent["assistantMessageEvent"] {
	if (event.type === "toolcall_start") {
		const toolCall = event.partial.content[event.contentIndex];
		if (toolCall?.type !== "toolCall") {
			throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
		}
		const { partial: _partial, ...deltaEvent } = event;
		return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
	}

	if (!("partial" in event)) {
		return event;
	}

	const { partial: _partial, ...deltaEvent } = event;
	return deltaEvent;
}

function toJsonMessageUpdate(event: MessageUpdateEvent): JsonMessageUpdateEvent {
	if (event.message.role !== "assistant") {
		throw new Error("message_update message is not an assistant message");
	}
	// Cumulative usage, tool-call ids, and tool names survive because their size
	// is constant; the snapshot itself is what the successor replaces.
	return {
		type: "message_update",
		usage: event.message.usage,
		assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
	};
}

/**
 * Project one session event onto the JSON/RPC stdout protocol.
 *
 * This is the only place that decides what a serialized transport writes, so a
 * transport cannot get the policy wrong by filtering at its own call site:
 *
 * - frames (`message_update`, `tool_execution_update`) return `undefined`
 *   unless the caller opts in — see {@link ToJsonEventOptions};
 * - `turn_end` / `agent_end` keep their structure and drop the messages they
 *   re-send;
 * - everything else is a fact and passes through.
 *
 * A transport writes the result when it is not `undefined` and does nothing
 * otherwise. In-process subscribers call `session.subscribe` directly and are
 * unaffected.
 */
export function toJsonEvent(
	event: MessageUpdateEvent,
	options?: ToJsonEventOptions,
): JsonMessageUpdateEvent | undefined;
export function toJsonEvent(event: AgentSessionEvent, options?: ToJsonEventOptions): JsonAgentSessionEvent | undefined;
export function toJsonEvent(
	event: AgentSessionEvent,
	options: ToJsonEventOptions = {},
): JsonAgentSessionEvent | undefined {
	if (isEphemeralSessionEvent(event) && options.includeLiveEvents !== true) return undefined;
	switch (event.type) {
		case "tool_execution_update":
			return boundedToolUpdate(event);
		case "message_update":
			return toJsonMessageUpdate(event);
		case "turn_end":
			return { type: "turn_end", messageRole: event.message.role, toolResultCount: event.toolResults.length };
		case "agent_end":
			return { type: "agent_end", willRetry: event.willRetry, messageCount: event.messages.length };
		default:
			return event;
	}
}
