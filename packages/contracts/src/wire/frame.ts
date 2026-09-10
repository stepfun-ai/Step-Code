// Framing codecs for the step-agent wire transport.
//
// This is the ONLY I/O the contracts package performs: turning payloads into
// self-delimiting frames and back. Two strategies are supported:
//   - length-prefixed: a big-endian uint32 length header followed by raw bytes.
//   - line: a UTF-8-safe text payload followed by a single "\n".
//
// Payload *serialization* (CBOR/JSON/etc.) is deliberately NOT part of this
// module; callers hand in already-serialized bytes or a single-line string.

import { WIRE_LENGTH_PREFIX_BYTES } from "./protocol.ts";

/** Result of a streaming decode: the frames fully available, plus leftover bytes. */
export interface LengthPrefixedDecodeResult {
	/** Complete payloads decoded from the buffer, in order. */
	readonly frames: Uint8Array[];
	/** Bytes belonging to a not-yet-complete trailing frame. Feed back in next call. */
	readonly rest: Uint8Array;
}

/** Result of a streaming line decode: complete lines, plus any trailing partial line. */
export interface LineDecodeResult {
	/** Complete payloads (delimiter stripped), in order. */
	readonly frames: string[];
	/** Trailing text with no terminating delimiter yet. Feed back in next call. */
	readonly rest: string;
}

/**
 * Encode a payload as a length-prefixed frame: a big-endian uint32 byte length
 * followed by the payload bytes.
 */
export function encodeLengthPrefixedFrame(payload: Uint8Array): Uint8Array {
	const frame = new Uint8Array(WIRE_LENGTH_PREFIX_BYTES + payload.length);
	const view = new DataView(frame.buffer);
	view.setUint32(0, payload.length, false);
	frame.set(payload, WIRE_LENGTH_PREFIX_BYTES);
	return frame;
}

/**
 * Decode as many complete length-prefixed frames as the buffer holds.
 * Any trailing partial frame (incomplete header or incomplete payload) is
 * returned in `rest` so a streaming caller can prepend it to the next chunk.
 */
export function decodeLengthPrefixedFrames(buffer: Uint8Array): LengthPrefixedDecodeResult {
	const frames: Uint8Array[] = [];
	let offset = 0;
	while (buffer.length - offset >= WIRE_LENGTH_PREFIX_BYTES) {
		const view = new DataView(buffer.buffer, buffer.byteOffset + offset, WIRE_LENGTH_PREFIX_BYTES);
		const length = view.getUint32(0, false);
		const frameEnd = offset + WIRE_LENGTH_PREFIX_BYTES + length;
		if (buffer.length < frameEnd) break;
		frames.push(buffer.slice(offset + WIRE_LENGTH_PREFIX_BYTES, frameEnd));
		offset = frameEnd;
	}
	return { frames, rest: buffer.slice(offset) };
}

/**
 * Encode a single-line payload as a line frame by appending the LF delimiter.
 * The payload must not itself contain a newline; embedded newlines would break
 * the self-delimiting invariant on decode.
 */
export function encodeLineFrame(payload: string): string {
	if (payload.includes("\n")) {
		throw new Error("line frame payload must not contain a newline");
	}
	return `${payload}\n`;
}

/**
 * Split a buffer into complete line frames on the LF delimiter. Any trailing text
 * with no terminating newline is returned in `rest` for the next chunk.
 */
export function decodeLineFrames(buffer: string): LineDecodeResult {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	return { frames: parts, rest };
}
