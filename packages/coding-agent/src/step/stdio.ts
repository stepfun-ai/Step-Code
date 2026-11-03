/**
 * Small compatibility boundary for Step's SDK stdio protocol.
 *
 * This module intentionally does not own a transport or an agent loop. The
 * frame codec is transport-neutral, while the event bridge delegates all
 * execution and queue semantics to pi's AgentSession.
 */

import type { ImageContent } from "@step-harness/providers";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../core/agent-session.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { StepCode } from "../stepcode-runtime.ts";

/** Published Step SDK wire constants. */
export const STEP_PROTOCOL_NAME = "step-agent-sdk" as const;
export const STEP_PROTOCOL_VERSION = 1 as const;
export const STEP_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const STEP_LENGTH_PREFIX_BYTES = 4;

/** Backwards-compatible aliases used by the existing Step runtime. */
export const SDK_STDIO_PROTOCOL_NAME = STEP_PROTOCOL_NAME;
export const SDK_STDIO_PROTOCOL_VERSION = STEP_PROTOCOL_VERSION;
export const SDK_STDIO_MAX_FRAME_BYTES = STEP_MAX_FRAME_BYTES;

export type StepFrameKind = "request" | "response" | "event";
export type SdkStdioFrameKind = StepFrameKind;

export interface StepProtocolError {
	readonly code: string;
	readonly message: string;
	readonly retryable?: boolean;
	readonly details?: Record<string, unknown>;
}

export type SdkStdioProtocolError = StepProtocolError;

/** JSON values are the only values allowed on the wire. */
export type StepJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly StepJsonValue[]
	| { readonly [key: string]: StepJsonValue };

/** The common Step v1 envelope. */
export interface StepFrame {
	readonly protocol: typeof STEP_PROTOCOL_NAME;
	readonly version: number;
	readonly kind: StepFrameKind;
	readonly id: string;
	readonly method?: string;
	readonly replyTo?: string;
	readonly sessionId?: string;
	readonly turnId?: string;
	readonly sequence?: number;
	readonly payload?: unknown;
	readonly error?: StepProtocolError;
}

export type SdkStdioFrame = StepFrame;
export type ProtocolFrame = StepFrame;

export class StepStdioProtocolViolation extends Error {
	readonly code: "PROTOCOL_VIOLATION" | "FRAME_TOO_LARGE" | "INCOMPLETE_FRAME" | "INVALID_UTF8" | "INVALID_JSON";

	constructor(
		message: string,
		code:
			| "PROTOCOL_VIOLATION"
			| "FRAME_TOO_LARGE"
			| "INCOMPLETE_FRAME"
			| "INVALID_UTF8"
			| "INVALID_JSON" = "PROTOCOL_VIOLATION",
	) {
		super(message);
		this.name = "StepStdioProtocolViolation";
		this.code = code;
	}
}

export const SdkStdioProtocolViolation = StepStdioProtocolViolation;

const FRAME_KINDS: ReadonlySet<string> = new Set(["request", "response", "event"]);

/** Runtime envelope guard. It deliberately accepts unknown protocol versions so a host can negotiate them. */
export function isStepStdioFrame(value: unknown): value is StepFrame {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const frame = value as Record<string, unknown>;
	if (
		frame.protocol !== STEP_PROTOCOL_NAME ||
		typeof frame.version !== "number" ||
		!Number.isSafeInteger(frame.version) ||
		frame.version < 1 ||
		typeof frame.kind !== "string" ||
		!FRAME_KINDS.has(frame.kind) ||
		typeof frame.id !== "string" ||
		frame.id.length === 0
	) {
		return false;
	}

	if (frame.kind === "request" || frame.kind === "event") {
		if (typeof frame.method !== "string" || frame.method.trim().length === 0) {
			return false;
		}
		return (
			frame.kind === "request" ||
			(typeof frame.sequence === "number" && Number.isSafeInteger(frame.sequence) && frame.sequence >= 0)
		);
	}
	if (typeof frame.replyTo !== "string" || frame.replyTo.trim().length === 0) {
		return false;
	}
	if (frame.payload !== undefined && frame.error !== undefined) {
		return false;
	}
	return frame.error === undefined || isStepProtocolError(frame.error);
}

export const isSdkStdioFrame = isStepStdioFrame;

function isStepProtocolError(value: unknown): value is StepProtocolError {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const error = value as Record<string, unknown>;
	return typeof error.code === "string" && typeof error.message === "string";
}

function assertFrame(frame: StepFrame): void {
	if (!isStepStdioFrame(frame)) {
		throw new StepStdioProtocolViolation("frame is not a valid Step protocol envelope");
	}
	if (frame.kind === "response" && frame.payload !== undefined && frame.error !== undefined) {
		throw new StepStdioProtocolViolation("response frame cannot contain both payload and error");
	}
}

/** Encode one Step frame as a 4-byte big-endian length prefix followed by UTF-8 JSON. */
export function encodeStepStdioFrame(frame: StepFrame, maxFrameBytes = STEP_MAX_FRAME_BYTES): Buffer {
	assertMaxFrameBytes(maxFrameBytes);
	assertFrame(frame);

	let json: string;
	try {
		json = JSON.stringify(frame);
	} catch (error) {
		throw new StepStdioProtocolViolation(
			`frame payload could not be serialized: ${error instanceof Error ? error.message : String(error)}`,
			"INVALID_JSON",
		);
	}
	const payload = Buffer.from(json, "utf8");
	if (payload.byteLength > maxFrameBytes) {
		throw new StepStdioProtocolViolation(
			`outgoing frame exceeds max frame size (${payload.byteLength} > ${maxFrameBytes} bytes)`,
			"FRAME_TOO_LARGE",
		);
	}
	const result = Buffer.allocUnsafe(STEP_LENGTH_PREFIX_BYTES + payload.byteLength);
	result.writeUInt32BE(payload.byteLength, 0);
	payload.copy(result, STEP_LENGTH_PREFIX_BYTES);
	return result;
}

export const encodeSdkStdioFrame = encodeStepStdioFrame;
export const encodeFrame = encodeStepStdioFrame;

function assertMaxFrameBytes(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > STEP_MAX_FRAME_BYTES) {
		throw new StepStdioProtocolViolation("maxFrameBytes must be a positive bounded integer");
	}
}

/**
 * Incremental decoder. It copies only the current frame payload, so a caller
 * can safely reuse or mutate the input chunk after `push` returns.
 */
export class StepStdioFrameDecoder {
	readonly #maxFrameBytes: number;
	readonly #prefix = Buffer.alloc(STEP_LENGTH_PREFIX_BYTES);
	#prefixBytes = 0;
	#payload: Buffer | undefined;
	#payloadBytes = 0;
	#expectedPayloadBytes: number | undefined;
	#closed = false;

	constructor(options?: { readonly maxFrameBytes?: number } | number) {
		const maxFrameBytes = typeof options === "number" ? options : options?.maxFrameBytes;
		assertMaxFrameBytes(maxFrameBytes ?? STEP_MAX_FRAME_BYTES);
		this.#maxFrameBytes = maxFrameBytes ?? STEP_MAX_FRAME_BYTES;
	}

	get maxFrameBytes(): number {
		return this.#maxFrameBytes;
	}

	get hasPendingInput(): boolean {
		return this.#prefixBytes > 0 || this.#expectedPayloadBytes !== undefined;
	}

	get closed(): boolean {
		return this.#closed;
	}

	push(chunk: Uint8Array): StepFrame[] {
		if (this.#closed) {
			throw new StepStdioProtocolViolation("frame decoder is closed");
		}
		if (!(chunk instanceof Uint8Array)) {
			throw new StepStdioProtocolViolation("frame decoder input must be a Uint8Array");
		}

		const frames: StepFrame[] = [];
		let offset = 0;
		while (offset < chunk.byteLength) {
			if (this.#expectedPayloadBytes === undefined) {
				while (this.#prefixBytes < STEP_LENGTH_PREFIX_BYTES && offset < chunk.byteLength) {
					this.#prefix[this.#prefixBytes] = chunk[offset];
					this.#prefixBytes += 1;
					offset += 1;
				}
				if (this.#prefixBytes < STEP_LENGTH_PREFIX_BYTES) {
					break;
				}

				const length = this.#prefix.readUInt32BE(0);
				if (length < 2 || length > this.#maxFrameBytes) {
					this.#resetCurrentFrame();
					throw new StepStdioProtocolViolation(
						`incoming frame exceeds max frame size (${length} > ${this.#maxFrameBytes} bytes)`,
						"FRAME_TOO_LARGE",
					);
				}
				this.#expectedPayloadBytes = length;
				this.#payload = Buffer.allocUnsafe(length);
				this.#payloadBytes = 0;
			}

			const remainingInput = chunk.byteLength - offset;
			const remainingPayload = this.#expectedPayloadBytes - this.#payloadBytes;
			const copied = Math.min(remainingInput, remainingPayload);
			this.#payload!.set(chunk.subarray(offset, offset + copied), this.#payloadBytes);
			this.#payloadBytes += copied;
			offset += copied;
			if (this.#payloadBytes < this.#expectedPayloadBytes) {
				break;
			}

			const payload = this.#payload!;
			this.#resetCurrentFrame();
			frames.push(this.#decode(payload));
		}
		return frames;
	}

	/** Signal EOF. A trailing prefix or payload is a protocol violation. */
	end(): void {
		if (this.#closed) {
			return;
		}
		if (this.hasPendingInput) {
			const pending = this.#prefixBytes + this.#payloadBytes;
			this.#resetCurrentFrame();
			this.#closed = true;
			throw new StepStdioProtocolViolation(
				`stream ended with ${pending} trailing bytes of a partial frame`,
				"INCOMPLETE_FRAME",
			);
		}
		this.#closed = true;
	}

	finish(): void {
		this.end();
	}

	#decode(payload: Buffer): StepFrame {
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
		} catch (error) {
			throw new StepStdioProtocolViolation(
				`frame payload is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
				"INVALID_UTF8",
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new StepStdioProtocolViolation(
				`frame payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
				"INVALID_JSON",
			);
		}
		if (!isStepStdioFrame(parsed)) {
			throw new StepStdioProtocolViolation("frame payload is not a valid protocol envelope");
		}
		return parsed;
	}

	#resetCurrentFrame(): void {
		this.#prefixBytes = 0;
		this.#payload = undefined;
		this.#payloadBytes = 0;
		this.#expectedPayloadBytes = undefined;
	}
}

export class SdkStdioFrameDecoder extends StepStdioFrameDecoder {}
export class FrameDecoder extends StepStdioFrameDecoder {}

/** A serializable projection of one pi AgentSession event. */
export interface PiHarnessEvent {
	readonly type: string;
	readonly session_id: string;
	readonly sequence: number;
	readonly [key: string]: StepJsonValue;
}

/** Event frame emitted by the optional frame sink. */
export interface PiHarnessEventFrame extends StepFrame {
	readonly kind: "event";
	readonly method: string;
	readonly sessionId: string;
	readonly sequence: number;
	readonly payload: PiHarnessEvent;
}

export interface PiHarnessEventBridgeOptions {
	/** Session id to put on projected events. Defaults to `session.sessionId`. */
	readonly sessionId?: string;
	/** Query id is included in the event payload when supplied. */
	readonly queryId?: string;
	/** Protocol method used by `onFrame`; defaults to `harness.event`. */
	readonly eventMethod?: string;
	/** Called synchronously for each projected event. */
	readonly onEvent?: (event: PiHarnessEvent) => void;
	/** Optional sink receiving a complete Step event frame. */
	readonly onFrame?: (frame: PiHarnessEventFrame) => void;
	/** Listener failures are contained and reported here. */
	readonly onError?: (error: unknown) => void;
}

export interface PiHarnessInputOptions {
	readonly images?: ImageContent[];
	/** Required when input arrives while the agent is streaming. */
	readonly streamingBehavior?: "steer" | "followUp";
	readonly source?: PromptOptions["source"];
}

export type PiHarnessInputCommand =
	| {
			readonly type: "prompt" | "input";
			readonly message: string;
			readonly images?: ImageContent[];
			readonly streamingBehavior?: "steer" | "followUp";
	  }
	| { readonly type: "steer"; readonly message: string; readonly images?: ImageContent[] }
	| { readonly type: "follow_up"; readonly message: string; readonly images?: ImageContent[] };

export interface PiHarnessEventBridge {
	readonly session: AgentSession;
	readonly sessionId: string;
	readonly closed: boolean;
	/** Send a prompt/input command through AgentSession. */
	input(messageOrCommand: string | PiHarnessInputCommand, options?: PiHarnessInputOptions): Promise<void>;
	/** Subscribe to already-projected, JSON-safe events. */
	subscribe(listener: (event: PiHarnessEvent) => void): () => void;
	/** Interrupt the active run; queue and lifecycle semantics remain pi-owned. */
	interrupt(): Promise<void>;
	/** Stop forwarding events and abort the active run. Does not dispose the session. */
	close(options?: { readonly abort?: boolean }): Promise<void>;
}

/** A single pi session, or a runtime that can replace its active session. */
export type PiHarnessEventSource = AgentSession | AgentSessionRuntime | StepCode;

/**
 * Adapt a pi AgentSession (or an AgentSessionRuntime) to Step-facing input and
 * event boundaries.
 *
 * No transport is opened here. A process host can feed decoded frames into
 * `input()` and encode the `onFrame` callback with the codec above.
 */
export function createPiHarnessEventBridge(
	source: PiHarnessEventSource,
	options: PiHarnessEventBridgeOptions = {},
): PiHarnessEventBridge {
	const runtime = isRuntimeSource(source) ? source : undefined;
	const initialSession = isRuntimeSource(source) ? source.session : source;
	let session: AgentSession = initialSession;
	let sessionId = options.sessionId ?? session.sessionId;
	const listeners = new Set<(event: PiHarnessEvent) => void>();
	let sequence = 0;
	let closed = false;
	let unsubscribeSession: (() => void) | undefined;

	const reportError = (error: unknown): void => {
		try {
			options.onError?.(error);
		} catch {
			// A diagnostic callback must never interfere with the agent loop.
		}
	};

	const emit = (raw: AgentSessionEvent): void => {
		if (closed) {
			return;
		}
		const event = projectPiEvent(raw, sessionId, ++sequence, options.queryId);
		for (const listener of [...listeners]) {
			try {
				listener(event);
			} catch (error) {
				reportError(error);
			}
		}
		try {
			options.onEvent?.(event);
		} catch (error) {
			reportError(error);
		}
		if (options.onFrame) {
			const frame: PiHarnessEventFrame = {
				protocol: STEP_PROTOCOL_NAME,
				version: STEP_PROTOCOL_VERSION,
				kind: "event",
				id: `rt_event_${sequence}`,
				method: options.eventMethod ?? "harness.event",
				sessionId,
				sequence,
				payload: event,
			};
			try {
				options.onFrame(frame);
			} catch (error) {
				reportError(error);
			}
		}
	};

	const bindSession = (nextSession: AgentSession): void => {
		if (closed) return;
		unsubscribeSession?.();
		session = nextSession;
		if (options.sessionId === undefined) {
			sessionId = nextSession.sessionId;
		}
		unsubscribeSession = session.subscribe(emit);
	};

	// Register before the first event can be emitted by a host. Runtime
	// replacement keeps this bridge's sequence and listeners intact.
	const removeRuntimeListener = runtime?.onSessionChange(bindSession);
	unsubscribeSession = session.subscribe(emit);

	const bridge: PiHarnessEventBridge = {
		get session() {
			return session;
		},
		get sessionId() {
			return sessionId;
		},
		get closed() {
			return closed;
		},
		async input(messageOrCommand: string | PiHarnessInputCommand, inputOptions?: PiHarnessInputOptions) {
			if (closed) {
				throw new Error("StepCode event bridge is closed");
			}
			if (typeof messageOrCommand === "string") {
				await session.prompt(messageOrCommand, {
					images: inputOptions?.images,
					streamingBehavior: inputOptions?.streamingBehavior,
					source: inputOptions?.source ?? "rpc",
				});
				return;
			}

			const command = messageOrCommand;
			if (command.type === "steer") {
				await session.steer(command.message, command.images);
				return;
			}
			if (command.type === "follow_up") {
				await session.followUp(command.message, command.images);
				return;
			}
			await session.prompt(command.message, {
				images: command.images,
				streamingBehavior: command.streamingBehavior,
				source: "rpc",
			});
		},
		subscribe(listener) {
			if (closed) {
				return () => {};
			}
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async interrupt() {
			if (closed) {
				return;
			}
			await session.abort();
		},
		async close(closeOptions) {
			if (closed) {
				return;
			}
			closed = true;
			listeners.clear();
			removeRuntimeListener?.();
			unsubscribeSession?.();
			unsubscribeSession = undefined;
			if (closeOptions?.abort !== false) {
				await session.abort();
			}
		},
	};

	return bridge;
}

function isRuntimeSource(source: PiHarnessEventSource): source is AgentSessionRuntime | StepCode {
	return typeof (source as { onSessionChange?: unknown }).onSessionChange === "function";
}

function projectPiEvent(
	event: AgentSessionEvent,
	sessionId: string,
	sequence: number,
	queryId: string | undefined,
): PiHarnessEvent {
	const projected = toStepJson(event, new WeakSet<object>());
	const details = isJsonObject(projected) ? projected : { value: projected };
	return {
		...details,
		type: event.type,
		session_id: sessionId,
		sequence,
		...(queryId === undefined ? {} : { query_id: queryId }),
	};
}

function isJsonObject(value: StepJsonValue): value is { readonly [key: string]: StepJsonValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Convert arbitrary extension/tool event data into bounded JSON-safe data. */
function toStepJson(value: unknown, seen: WeakSet<object>): StepJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : String(value);
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "undefined") {
		return null;
	}
	if (typeof value === "function" || typeof value === "symbol") {
		return `[${typeof value}]`;
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			...(value.stack ? { stack: value.stack } : {}),
		};
	}
	if (seen.has(value)) {
		return "[Circular]";
	}
	seen.add(value);
	if (Array.isArray(value)) {
		const result = value.map((item) => toStepJson(item, seen));
		seen.delete(value);
		return result;
	}
	if (value instanceof Set) {
		const result = [...value].map((item) => toStepJson(item, seen));
		seen.delete(value);
		return result;
	}
	if (value instanceof Map) {
		const object: Record<string, StepJsonValue> = {};
		for (const [key, item] of value.entries()) {
			object[String(key)] = toStepJson(item, seen);
		}
		seen.delete(value);
		return object;
	}

	const object: Record<string, StepJsonValue> = {};
	for (const key of Object.keys(value)) {
		try {
			object[key] = toStepJson((value as Record<string, unknown>)[key], seen);
		} catch (error) {
			object[key] = `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
		}
	}
	seen.delete(value);
	return object;
}
