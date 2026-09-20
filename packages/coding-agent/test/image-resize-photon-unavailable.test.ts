import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/photon.ts", () => ({
	loadPhoton: vi.fn(),
}));

import { resizeImageInProcess } from "../src/utils/image-resize-core.ts";
import { loadPhoton } from "../src/utils/photon.ts";

const TINY_PNG_2x2 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

const TINY_JPEG_2x2 =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";

// Handcrafted PNG that declares a 4000x4000 image via IHDR only (no pixel data
// needed for the header parser). Well over the 2000px default.
function makeOversizePngHeader(width: number, height: number): Uint8Array {
	const buf = Buffer.alloc(24);
	buf[0] = 0x89;
	buf.write("PNG\r\n\x1a\n", 1, "binary");
	buf.writeUInt32BE(13, 8);
	buf.write("IHDR", 12, "ascii");
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

function b64(base64: string): Uint8Array {
	return new Uint8Array(Buffer.from(base64, "base64"));
}

describe("resizeImageInProcess without Photon", () => {
	beforeEach(() => {
		vi.mocked(loadPhoton).mockReset();
		vi.mocked(loadPhoton).mockResolvedValue(null);
	});

	afterEach(() => {
		vi.mocked(loadPhoton).mockReset();
	});

	it("passes a tiny PNG through untouched when Photon is unavailable", async () => {
		const bytes = b64(TINY_PNG_2x2);
		const result = await resizeImageInProcess(bytes, "image/png");

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(false);
		expect(result!.mimeType).toBe("image/png");
		expect(result!.originalWidth).toBe(2);
		expect(result!.originalHeight).toBe(2);
		expect(result!.width).toBe(2);
		expect(result!.height).toBe(2);
		expect(result!.data).toBe(TINY_PNG_2x2);
	});

	it("passes a tiny JPEG through untouched when Photon is unavailable", async () => {
		const bytes = b64(TINY_JPEG_2x2);
		const result = await resizeImageInProcess(bytes, "image/jpeg");

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(false);
		expect(result!.mimeType).toBe("image/jpeg");
		expect(result!.originalWidth).toBe(2);
		expect(result!.originalHeight).toBe(2);
		expect(result!.data).toBe(TINY_JPEG_2x2);
	});

	it("refuses to pass an oversize image through even when Photon is unavailable", async () => {
		const oversize = makeOversizePngHeader(4000, 4000);
		const result = await resizeImageInProcess(oversize, "image/png", {
			maxWidth: 2000,
			maxHeight: 2000,
			maxBytes: 4.5 * 1024 * 1024,
		});
		expect(result).toBeNull();
	});

	it("refuses to pass an image whose base64 payload already blows the byte budget", async () => {
		const bytes = b64(TINY_PNG_2x2);
		const result = await resizeImageInProcess(bytes, "image/png", {
			maxWidth: 2000,
			maxHeight: 2000,
			maxBytes: 1,
		});
		expect(result).toBeNull();
	});

	it("refuses to pass through data with an unrecognized image container", async () => {
		const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);
		const result = await resizeImageInProcess(junk, "image/png");
		expect(result).toBeNull();
	});
});

type PhotonModule = NonNullable<Awaited<ReturnType<typeof loadPhoton>>>;

// Photon loads fine but rejects this specific image (container variants its
// decoder does not support, corrupt metadata). The throw must land in the
// resize path's catch block, not the module-missing branch.
function photonThatThrowsOnDecode(decodeSpy: () => never): PhotonModule {
	return {
		PhotonImage: {
			new_from_byteslice: decodeSpy,
		},
	} as unknown as PhotonModule;
}

describe("resizeImageInProcess when Photon throws on decode", () => {
	const decodeSpy = vi.fn<() => never>(() => {
		throw new Error("unsupported image container");
	});

	beforeEach(() => {
		decodeSpy.mockClear();
		vi.mocked(loadPhoton).mockReset();
		vi.mocked(loadPhoton).mockResolvedValue(photonThatThrowsOnDecode(decodeSpy));
	});

	afterEach(() => {
		vi.mocked(loadPhoton).mockReset();
	});

	it("passes an in-budget original through untouched when decoding throws", async () => {
		const bytes = b64(TINY_PNG_2x2);
		const result = await resizeImageInProcess(bytes, "image/png");

		expect(decodeSpy).toHaveBeenCalledTimes(1);
		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(false);
		expect(result!.mimeType).toBe("image/png");
		expect(result!.originalWidth).toBe(2);
		expect(result!.originalHeight).toBe(2);
		expect(result!.width).toBe(2);
		expect(result!.height).toBe(2);
		expect(result!.data).toBe(TINY_PNG_2x2);
	});

	it("still refuses an oversize image when decoding throws", async () => {
		const oversize = makeOversizePngHeader(4000, 4000);
		const result = await resizeImageInProcess(oversize, "image/png");

		expect(decodeSpy).toHaveBeenCalledTimes(1);
		expect(result).toBeNull();
	});

	it("still refuses an image whose base64 payload blows the byte budget when decoding throws", async () => {
		const bytes = b64(TINY_PNG_2x2);
		const result = await resizeImageInProcess(bytes, "image/png", { maxBytes: 1 });

		expect(decodeSpy).toHaveBeenCalledTimes(1);
		expect(result).toBeNull();
	});

	it("still refuses data with an unrecognized image container when decoding throws", async () => {
		const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);
		const result = await resizeImageInProcess(junk, "image/png");

		expect(decodeSpy).toHaveBeenCalledTimes(1);
		expect(result).toBeNull();
	});
});
