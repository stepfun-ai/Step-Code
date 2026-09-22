export interface ImageDimensions {
	width: number;
	height: number;
}

/**
 * Extract raw pixel dimensions from PNG/JPEG/GIF/WebP header bytes without
 * decoding the image. Returns null when the format is not recognized or the
 * header is malformed. Used to make passthrough decisions when Photon/WASM is
 * unavailable — the check is intentionally conservative and skips exotic
 * container variants rather than guessing.
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
	return readPng(bytes) ?? readJpeg(bytes) ?? readGif(bytes) ?? readWebp(bytes);
}

function readPng(bytes: Uint8Array): ImageDimensions | null {
	if (bytes.length < 24) return null;
	if (
		bytes[0] !== 0x89 ||
		bytes[1] !== 0x50 ||
		bytes[2] !== 0x4e ||
		bytes[3] !== 0x47 ||
		bytes[4] !== 0x0d ||
		bytes[5] !== 0x0a ||
		bytes[6] !== 0x1a ||
		bytes[7] !== 0x0a
	) {
		return null;
	}
	if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
		return null;
	}
	const width = readUint32BE(bytes, 16);
	const height = readUint32BE(bytes, 20);
	if (width === 0 || height === 0) return null;
	return { width, height };
}

function readJpeg(bytes: Uint8Array): ImageDimensions | null {
	if (bytes.length < 4) return null;
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

	let offset = 2;
	while (offset + 1 < bytes.length) {
		if (bytes[offset] !== 0xff) return null;
		let marker = bytes[offset + 1];
		offset += 2;
		// Skip fill bytes (0xff padding).
		while (marker === 0xff && offset < bytes.length) {
			marker = bytes[offset];
			offset += 1;
		}
		if (marker === undefined) return null;

		// Bail cleanly once we reach start-of-scan or end-of-image: any bytes
		// past SOS are entropy-coded scan data, and treating a random 0xff xx
		// stuff-byte as another marker would produce garbage dimensions instead
		// of a null verdict.
		if (marker === 0xda || marker === 0xd9) return null;

		// Standalone markers with no length: SOI (D8), TEM (01), RSTn (D0-D7).
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			continue;
		}

		if (offset + 2 > bytes.length) return null;
		const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
		if (segmentLength < 2) return null;
		if (offset + segmentLength > bytes.length) return null;

		// SOFn markers except DHT (0xC4), JPG (0xC8), DAC (0xCC).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (segmentLength < 7 || offset + 7 > bytes.length) return null;
			const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
			const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
			if (width === 0 || height === 0) return null;
			return { width, height };
		}

		offset += segmentLength;
	}

	return null;
}

function readGif(bytes: Uint8Array): ImageDimensions | null {
	if (bytes.length < 10) return null;
	if (
		bytes[0] !== 0x47 ||
		bytes[1] !== 0x49 ||
		bytes[2] !== 0x46 ||
		bytes[3] !== 0x38 ||
		(bytes[4] !== 0x37 && bytes[4] !== 0x39) ||
		bytes[5] !== 0x61
	) {
		return null;
	}
	const width = bytes[6] | (bytes[7] << 8);
	const height = bytes[8] | (bytes[9] << 8);
	if (width === 0 || height === 0) return null;
	return { width, height };
}

function readWebp(bytes: Uint8Array): ImageDimensions | null {
	if (bytes.length < 30) return null;
	if (
		bytes[0] !== 0x52 ||
		bytes[1] !== 0x49 ||
		bytes[2] !== 0x46 ||
		bytes[3] !== 0x46 ||
		bytes[8] !== 0x57 ||
		bytes[9] !== 0x45 ||
		bytes[10] !== 0x42 ||
		bytes[11] !== 0x50
	) {
		return null;
	}
	const fourCc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
	if (fourCc === "VP8 ") {
		if (bytes.length < 30) return null;
		if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
		const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
		const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
		if (width === 0 || height === 0) return null;
		return { width, height };
	}
	if (fourCc === "VP8L") {
		if (bytes.length < 25) return null;
		if (bytes[20] !== 0x2f) return null;
		const b0 = bytes[21];
		const b1 = bytes[22];
		const b2 = bytes[23];
		const b3 = bytes[24];
		const width = 1 + (((b1 & 0x3f) << 8) | b0);
		const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
		if (width === 0 || height === 0) return null;
		return { width, height };
	}
	if (fourCc === "VP8X") {
		if (bytes.length < 30) return null;
		const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
		const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
		if (width === 0 || height === 0) return null;
		return { width, height };
	}
	return null;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] ?? 0) * 0x1000000 +
		((bytes[offset + 1] ?? 0) << 16) +
		((bytes[offset + 2] ?? 0) << 8) +
		(bytes[offset + 3] ?? 0)
	);
}
