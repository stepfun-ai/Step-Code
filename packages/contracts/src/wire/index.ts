// Barrel for the wire (transport) contract surface.
// Exported as the "./wire" subpath ("@step-harness/contracts/wire").

export type { WireEvent, WireEventChannel, WireEventEnvelope } from "./events.ts";
export type { LengthPrefixedDecodeResult, LineDecodeResult } from "./frame.ts";
export {
	decodeLengthPrefixedFrames,
	decodeLineFrames,
	encodeLengthPrefixedFrame,
	encodeLineFrame,
} from "./frame.ts";
export type { WireFrameKind, WireHandshake } from "./protocol.ts";
export {
	STEP_AGENT_SDK_PROTOCOL_NAME,
	STEP_AGENT_SDK_PROTOCOL_VERSION,
	WIRE_LENGTH_PREFIX_BYTES,
	WIRE_LINE_FRAME_DELIMITER,
} from "./protocol.ts";
