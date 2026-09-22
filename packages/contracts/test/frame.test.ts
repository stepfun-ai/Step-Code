import { describe, expect, it } from "vitest";
import {
	decodeLengthPrefixedFrames,
	decodeLineFrames,
	encodeLengthPrefixedFrame,
	encodeLineFrame,
} from "../src/wire/frame.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

describe("length-prefixed frames", () => {
	it("round-trips a batch of payloads through a single buffer", () => {
		const payloads = [
			textEncoder.encode("hello"),
			new Uint8Array([]), // zero-length payload
			textEncoder.encode("a longer payload with unicode: café 🚀"),
			new Uint8Array([0, 1, 2, 253, 254, 255]), // raw non-text bytes
		];

		const chunks = payloads.map((p) => encodeLengthPrefixedFrame(p));
		const total = chunks.reduce((n, c) => n + c.length, 0);
		const buffer = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			buffer.set(chunk, offset);
			offset += chunk.length;
		}

		const { frames, rest } = decodeLengthPrefixedFrames(buffer);
		expect(rest.length).toBe(0);
		expect(frames.length).toBe(payloads.length);
		for (let i = 0; i < payloads.length; i++) {
			expect(Array.from(frames[i])).toEqual(Array.from(payloads[i]));
		}
	});

	it("returns an incomplete trailing frame as rest without losing bytes", () => {
		const complete = encodeLengthPrefixedFrame(textEncoder.encode("first"));
		const partial = encodeLengthPrefixedFrame(textEncoder.encode("second")).slice(0, 5);
		const buffer = new Uint8Array(complete.length + partial.length);
		buffer.set(complete, 0);
		buffer.set(partial, complete.length);

		const { frames, rest } = decodeLengthPrefixedFrames(buffer);
		expect(frames.length).toBe(1);
		expect(textDecoder.decode(frames[0])).toBe("first");
		expect(Array.from(rest)).toEqual(Array.from(partial));
	});
});

describe("line frames", () => {
	it("round-trips newline-delimited payloads", () => {
		const payloads = ["one", "two", "", "three with spaces"];
		const buffer = payloads.map((p) => encodeLineFrame(p)).join("");

		const { frames, rest } = decodeLineFrames(buffer);
		expect(rest).toBe("");
		expect(frames).toEqual(payloads);
	});

	it("keeps a trailing partial line as rest", () => {
		const buffer = `${encodeLineFrame("complete")}partial-no-newline`;
		const { frames, rest } = decodeLineFrames(buffer);
		expect(frames).toEqual(["complete"]);
		expect(rest).toBe("partial-no-newline");
	});

	it("rejects payloads that contain the delimiter", () => {
		expect(() => encodeLineFrame("bad\npayload")).toThrow();
	});
});
