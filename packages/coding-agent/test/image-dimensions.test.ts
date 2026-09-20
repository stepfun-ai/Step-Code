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

// Handcrafted RIFF/WEBP lossy (VP8 ): 0x9d 0x01 0x2a start code then 14-bit LE dims.
function makeWebpVp8(width: number, height: number): Uint8Array {
	const buf = Buffer.alloc(30);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(22, 4);
	buf.write("WEBP", 8, "ascii");
	buf.write("VP8 ", 12, "ascii");
	buf.writeUInt32LE(10, 16);
	buf[23] = 0x9d;
	buf[24] = 0x01;
	buf[25] = 0x2a;
	buf.writeUInt16LE(width & 0x3fff, 26);
	buf.writeUInt16LE(height & 0x3fff, 28);
	return buf;
}

// Handcrafted RIFF/WEBP lossless (VP8L): 0x2f signature then 14-bit width-1/height-1
// packed across 4 bytes (width low8 | width high6 + height low2 | height mid8 | height high4).
function makeWebpVp8l(width: number, height: number): Uint8Array {
	const buf = Buffer.alloc(30);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(22, 4);
	buf.write("WEBP", 8, "ascii");
	buf.write("VP8L", 12, "ascii");
	buf.writeUInt32LE(10, 16);
	buf[20] = 0x2f;
	const w = width - 1;
	const h = height - 1;
	buf[21] = w & 0xff;
	buf[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
	buf[23] = (h >> 2) & 0xff;
	buf[24] = (h >> 10) & 0x0f;
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

	it("reads WebP VP8 (lossy) dimensions", () => {
		expect(readImageDimensions(makeWebpVp8(300, 430))).toEqual({ width: 300, height: 430 });
	});

	it("reads WebP VP8L (lossless) dimensions across the packed byte boundary", () => {
		expect(readImageDimensions(makeWebpVp8l(300, 430))).toEqual({ width: 300, height: 430 });
	});

	it("reads WebP VP8L dimensions using the high-order width/height bits", () => {
		// 1600x1200 forces the top VP8L byte (height bits 10-13) and the full 6-bit
		// width high field non-zero, which 300x430 leaves at 0.
		expect(readImageDimensions(makeWebpVp8l(1600, 1200))).toEqual({ width: 1600, height: 1200 });
	});

	it("ignores WebP VP8 scale bits in the top two dimension bits", () => {
		const buf = makeWebpVp8(300, 430);
		buf[27] |= 0xc0; // horizontal scale bits, stripped by the 0x3fff mask
		buf[29] |= 0xc0; // vertical scale bits
		expect(readImageDimensions(buf)).toEqual({ width: 300, height: 430 });
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
