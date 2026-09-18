import { describe, expect, it } from "vitest";
import { readImageDimensions } from "../src/utils/image-dimensions.ts";

// 2x2 red PNG generated with ImageMagick.
const TINY_PNG_2x2 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

const TINY_JPEG_2x2 =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";

// Handcrafted 3x5 GIF89a. 6 byte signature + 2 byte LE width + 2 byte LE height.
function makeGif89a(width: number, height: number): Uint8Array {
	const buf = Buffer.alloc(13);
	buf.write("GIF89a", 0, "ascii");
	buf.writeUInt16LE(width, 6);
	buf.writeUInt16LE(height, 8);
	buf[10] = 0x00;
	buf[11] = 0x00;
	buf[12] = 0x00;
	return buf;
}

// Handcrafted RIFF/WEBP with a VP8X chunk carrying 24-bit width/height fields.
function makeWebpVp8x(width: number, height: number): Uint8Array {
	const buf = Buffer.alloc(30);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(22, 4);
	buf.write("WEBP", 8, "ascii");
	buf.write("VP8X", 12, "ascii");
	buf.writeUInt32LE(10, 16);
	buf[20] = 0x00;
	buf.writeUIntLE(width - 1, 24, 3);
	buf.writeUIntLE(height - 1, 27, 3);
	return buf;
}

function b64(base64: string): Uint8Array {
	return new Uint8Array(Buffer.from(base64, "base64"));
}

describe("readImageDimensions", () => {
	it("reads PNG dimensions from the IHDR chunk", () => {
		expect(readImageDimensions(b64(TINY_PNG_2x2))).toEqual({ width: 2, height: 2 });
	});

	it("reads JPEG dimensions from the SOF marker", () => {
		expect(readImageDimensions(b64(TINY_JPEG_2x2))).toEqual({ width: 2, height: 2 });
	});

	it("reads GIF logical screen dimensions", () => {
		expect(readImageDimensions(makeGif89a(3, 5))).toEqual({ width: 3, height: 5 });
	});

	it("reads WebP VP8X extended dimensions", () => {
		expect(readImageDimensions(makeWebpVp8x(1148, 642))).toEqual({ width: 1148, height: 642 });
	});

	it("returns null for unrecognized bytes", () => {
		expect(readImageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull();
	});

	it("returns null for a truncated PNG header", () => {
		expect(readImageDimensions(b64(TINY_PNG_2x2).slice(0, 16))).toBeNull();
	});

	it("returns null for a JPEG whose SOFn was stripped before SOS", () => {
		// Handcrafted JPEG: SOI + APP0 (skippable) + SOS. No SOF. A permissive
		// parser that length-skips SOS would walk into entropy data and might
		// misread stuffing bytes as a fake SOF.
		const buf = Buffer.concat([
			Buffer.from([0xff, 0xd8]), // SOI
			Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), // APP0 len=4
			Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]), // SOS
			// Entropy-coded payload containing 0xFF 0xC0 (would fake a baseline SOF).
			Buffer.from([0xff, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x2c, 0x03, 0x01, 0x22, 0x00]),
			Buffer.from([0xff, 0xd9]), // EOI
		]);
		expect(readImageDimensions(new Uint8Array(buf))).toBeNull();
	});

	it("returns null for a JPEG segment length that overruns the buffer", () => {
		// SOI + APP0 marker with declared length past end of buffer.
		const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x7f, 0xff, 0x00, 0x00]);
		expect(readImageDimensions(new Uint8Array(buf))).toBeNull();
	});
});
