// Wire protocol identity and frame-structure constants for the step-agent SDK
// transport. This module holds only names, versions, and structural constants;
// the actual byte/line codecs live in ./frame.ts, and serialization of payloads
// (CBOR/JSON) is intentionally out of scope for the contracts package.

/** Protocol name carried in every handshake for the step-agent wire transport. */
export const STEP_AGENT_SDK_PROTOCOL_NAME = "step-agent-sdk" as const;

/**
 * Semantic version of the wire protocol described by this contracts package.
 *
 * Named with the full `STEP_AGENT_SDK_` prefix on purpose so it is never matched
 * by a bare `PROTOCOL_VERSION` scan targeting the (now removed) remote/CBOR link.
 */
export const STEP_AGENT_SDK_PROTOCOL_VERSION = "1" as const;

/** The two framing strategies the transport understands. */
export type WireFrameKind = "length-prefixed" | "line";

/**
 * Byte width of the length-prefixed frame header. Each length-prefixed frame is a
 * big-endian unsigned 32-bit payload length followed by exactly that many bytes.
 */
export const WIRE_LENGTH_PREFIX_BYTES = 4 as const;

/** Delimiter byte (newline, LF) that terminates each frame in the line transport. */
export const WIRE_LINE_FRAME_DELIMITER = 0x0a as const;

/** Handshake announced by both peers before any framed traffic. */
export interface WireHandshake {
	readonly protocol: typeof STEP_AGENT_SDK_PROTOCOL_NAME;
	readonly version: typeof STEP_AGENT_SDK_PROTOCOL_VERSION;
	/** Framing strategy the sender will use for subsequent frames. */
	readonly frameKind: WireFrameKind;
}
