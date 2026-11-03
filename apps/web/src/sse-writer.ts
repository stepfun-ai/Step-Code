import { omitImageData, withoutToolResultImages } from "./omitted-images.ts";
import type { WebEvent } from "./runtime.ts";

/** Longest a streamed message update waits for the next one (25 frames a second). */
export const STREAM_FRAME_MS = 40;

/** What one SSE connection writes: an event name and its JSON body. */
export type SseWrite = (eventName: string, data: string) => void;

type AgentWebEvent = Extract<WebEvent, { type: "agent" }>;

/** What a connection last sent for one content block: the growing strings a later frame may extend. */
interface SentBlock {
	readonly type: unknown;
	readonly text?: string;
	readonly args?: ReadonlyMap<string, string>;
}

function isMessageBoundary(event: WebEvent): boolean {
	return event.type === "agent" && (event.event.type === "message_start" || event.event.type === "message_end");
}

type AnyEvent = Record<string, unknown>;

/** `value[key]` replaced by `map(value[key])`, or `value` itself when that changes nothing. */
function withField(value: AnyEvent, key: string, map: (field: unknown) => unknown): AnyEvent {
	if (!(key in value)) return value;
	const before = value[key];
	const after = map(before);
	return after === before ? value : { ...value, [key]: after };
}

function withoutResultImages(result: unknown): unknown {
	return result && typeof result === "object" ? withField(result as AnyEvent, "content", omitImageData) : result;
}

function listWithoutImages(messages: unknown): unknown {
	if (!Array.isArray(messages)) return messages;
	const mapped = messages.map(withoutToolResultImages);
	return mapped.some((message, index) => message !== messages[index]) ? mapped : messages;
}

/** An agent event whose tool-result images are placeholders; the same object when it has none. */
function withoutImages(stamped: AgentWebEvent): AgentWebEvent {
	let event = stamped.event as unknown as AnyEvent;
	event = withField(event, "result", withoutResultImages);
	event = withField(event, "partialResult", withoutResultImages);
	event = withField(event, "message", withoutToolResultImages);
	event = withField(event, "toolResults", listWithoutImages);
	event = withField(event, "messages", listWithoutImages);
	return event === (stamped.event as unknown) ? stamped : ({ ...stamped, event } as unknown as AgentWebEvent);
}

/** The field a streamed text or thinking block grows in. */
function textField(block: Record<string, unknown>): "text" | "thinking" | undefined {
	if (block.type === "text" && typeof block.text === "string") return "text";
	if (block.type === "thinking" && typeof block.thinking === "string") return "thinking";
	return undefined;
}

/** `now` is `before` with something (or nothing) appended: a frame can send just the tail. */
function extends_(now: string, before: string | undefined): before is string {
	return before !== undefined && now.length >= before.length && now.startsWith(before);
}

/**
 * One SSE connection's writer for a session's events.
 *
 * The kernel publishes a `message_update` per provider chunk, each carrying the
 * whole message so far twice (the event's `message` and the delta's `partial`)
 * and, for a streaming tool call, the raw argument text a third time: a long
 * reply or file write sent quadratically more bytes the longer it got. This
 * writer sends at most one update per `STREAM_FRAME_MS` (the newest replaces any
 * that waited, so nothing the page draws is skipped) and shortens it:
 *
 * - the delta's `partial` copy and a tool call's raw `partialArgs` are dropped;
 * - with `tails` (a client that rebuilds them, `?delta=1` on the events route):
 *   a text or thinking block that only grew (or stayed the same) since this
 *   connection last sent it carries just the appended tail, possibly empty, and
 *   `appendedTo`, the length it extends; likewise a tool call's top-level string
 *   arguments (a file's content as it is written), listed in `appendedArguments`.
 *   Without it each update carries its message whole, so a page loaded from an
 *   older bundle still reads it.
 *
 * A running call's `tool_execution_update` carries all of its output so far, so
 * it is kept the same way: the newest per call, at most once per frame. Any other
 * event first flushes what waits, so the page applies events in the order the
 * kernel published them. A message boundary, or a message with another
 * timestamp, starts the block memory over, and a new connection starts with
 * none, so its first update is always complete (`client/src/state/live-message.ts`
 * rebuilds the message on the page side).
 *
 * Tool-result images leave every agent event as placeholders (`omitted-images.ts`),
 * the way the snapshot sends them: the page never draws them.
 */
export class SseSessionWriter {
	/** Updates waiting for the frame, by stream (`message`, or `tool:<id>`), oldest first. */
	private readonly pending = new Map<string, AgentWebEvent>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private sent: { timestamp?: unknown; blocks: Map<number, SentBlock> } = { blocks: new Map() };
	private closed = false;
	private readonly write: SseWrite;
	private readonly frameMs: number;
	private readonly tails: boolean;

	constructor(write: SseWrite, options: { readonly frameMs?: number; readonly tails?: boolean } = {}) {
		this.write = write;
		this.frameMs = options.frameMs ?? STREAM_FRAME_MS;
		this.tails = options.tails === true;
	}

	publish(event: WebEvent): void {
		if (this.closed) return;
		if (event.type === "agent") {
			const key =
				event.event.type === "message_update"
					? "message"
					: event.event.type === "tool_execution_update"
						? `tool:${event.event.toolCallId}`
						: undefined;
			if (key) {
				// Re-inserted, so updates leave in the order their newest versions arrived.
				this.pending.delete(key);
				this.pending.set(key, event);
				this.timer ??= setTimeout(() => this.flush(), this.frameMs);
				return;
			}
		}
		this.flush();
		if (isMessageBoundary(event)) this.sent = { blocks: new Map() };
		const body = event.type === "agent" ? withoutImages(event) : event;
		this.write(event.type === "error" ? "web_error" : event.type, JSON.stringify(body));
	}

	/** Write what waits for the frame now. */
	flush(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		const waiting = [...this.pending.values()];
		this.pending.clear();
		if (this.closed) return;
		for (const event of waiting) {
			const body = event.event.type === "message_update" ? this.shorten(event) : withoutImages(event);
			this.write("agent", JSON.stringify(body));
		}
	}

	/** Stop writing; updates still waiting are dropped with the connection. */
	close(): void {
		this.closed = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
	}

	private shorten(stamped: AgentWebEvent): AgentWebEvent {
		const event = stamped.event as unknown as {
			message?: Record<string, unknown>;
			assistantMessageEvent?: Record<string, unknown>;
		};
		const message = event.message;
		if (message?.timestamp !== this.sent.timestamp) this.sent = { timestamp: message?.timestamp, blocks: new Map() };
		const blocks = Array.isArray(message?.content) ? (message.content as unknown[]) : undefined;
		const content = blocks?.map((block, index) => this.shortenBlock(block, index));
		const { partial: _copy, ...delta } = event.assistantMessageEvent ?? {};
		return {
			...stamped,
			event: {
				...stamped.event,
				...(message && content ? { message: { ...message, content } } : {}),
				...(event.assistantMessageEvent ? { assistantMessageEvent: delta } : {}),
			},
		} as AgentWebEvent;
	}

	private shortenBlock(block: unknown, index: number): unknown {
		if (!block || typeof block !== "object") return block;
		const { partialArgs: _raw, ...part } = block as Record<string, unknown>;
		if (!this.tails) return part;
		const before = this.sent.blocks.get(index);
		const same = before?.type === part.type;
		const field = textField(part);
		if (field) {
			const text = part[field] as string;
			this.sent.blocks.set(index, { type: part.type, text });
			return same && extends_(text, before?.text)
				? { ...part, [field]: text.slice(before.text.length), appendedTo: before.text.length }
				: part;
		}
		const args = part.arguments;
		if (part.type !== "toolCall" || !args || typeof args !== "object" || Array.isArray(args)) {
			this.sent.blocks.set(index, { type: part.type });
			return part;
		}
		const strings = new Map<string, string>();
		const shortened: Record<string, unknown> = {};
		const appended: Record<string, number> = {};
		for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
			shortened[key] = value;
			if (typeof value !== "string") continue;
			strings.set(key, value);
			const was = same ? before?.args?.get(key) : undefined;
			if (extends_(value, was)) {
				shortened[key] = value.slice(was.length);
				appended[key] = was.length;
			}
		}
		this.sent.blocks.set(index, { type: part.type, args: strings });
		return Object.keys(appended).length ? { ...part, arguments: shortened, appendedArguments: appended } : part;
	}
}
