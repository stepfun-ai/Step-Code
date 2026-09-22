import { applyExifOrientation } from "./exif-orientation.ts";
import { readImageDimensions } from "./image-dimensions.ts";
import { loadPhoton } from "./photon.ts";

export interface ImageResizeOptions {
	maxWidth?: number; // Default: 2000
	maxHeight?: number; // Default: 2000
	maxBytes?: number; // Default: 100MB of base64 payload (see DEFAULT_MAX_BYTES)
	jpegQuality?: number; // Default: 80
}

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

// 100MB of base64 payload. The Step backend accepts far larger inline images than
// Anthropic's 5MB cap, so within the pixel budget an image is sent without byte-driven
// re-compression; the re-encode ladder below then only triggers on a pixel overage.
// A run targeting a 5MB-capped dialect (e.g. anthropic) should pass a smaller maxBytes.
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null only when the image cannot be decoded AND the container header
 * cannot prove it fits both budgets; a decodable image always yields a result.
 *
 * Uses Photon (Rust/WASM) for image processing. When Photon is unavailable
 * (release-binary layout gaps, WASM load failures) or throws on this specific
 * image (a container variant its decoder rejects, corrupt metadata), fall back
 * to a header-only dimension read: if the raw image already fits both the pixel
 * and base64 size budgets, pass it through untouched; otherwise return null so
 * the caller surfaces a real "cannot resize" error instead of dropping a
 * compliant image.
 *
 * Strategy for staying under maxBytes (mirrors Claude Code's read pipeline):
 * 1. Within the pixel and byte budgets: pass the original through untouched
 * 2. Over bytes but within pixels: re-encode at the original dimensions
 *    (PNG, then JPEG at descending quality) without resampling
 * 3. Over pixels: resize to fit maxWidth/maxHeight, then the same ladder
 * 4. Last resort, never fails: JPEG quality 20 at up-to-1000px width,
 *    returned even if it still exceeds maxBytes, so a decodable image is
 *    never dropped
 */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

	const photon = await loadPhoton();
	if (!photon) {
		return passthroughIfWithinLimits(inputBytes, mimeType, inputBase64Size, opts);
	}

	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) rawImage.free();

		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const format = mimeType.split("/")[1] ?? "png";

		// Check if already within all limits (dimensions AND encoded size)
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size <= opts.maxBytes) {
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType: mimeType || `image/${format}`,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		type PhotonImageHandle = NonNullable<typeof image>;
		// Claude Code's encode ladder: PNG first, then JPEG at descending
		// quality; the first candidate within the byte budget wins.
		const jpegQualities = Array.from(new Set([opts.jpegQuality, 60, 40, 20]));
		function encodeLadder(target: PhotonImageHandle): EncodedCandidate | null {
			const png = encodeCandidate(target.get_bytes(), "image/png");
			if (png.encodedSize <= opts.maxBytes) return png;
			for (const quality of jpegQualities) {
				const jpeg = encodeCandidate(target.get_bytes_jpeg(quality), "image/jpeg");
				if (jpeg.encodedSize <= opts.maxBytes) return jpeg;
			}
			return null;
		}

		// Over bytes but within the pixel budget: re-encode at the original
		// dimensions without resampling.
		const overDims = originalWidth > opts.maxWidth || originalHeight > opts.maxHeight;
		if (!overDims) {
			const reencoded = encodeLadder(image);
			if (reencoded) {
				return {
					data: reencoded.data,
					mimeType: reencoded.mimeType,
					originalWidth,
					originalHeight,
					width: originalWidth,
					height: originalHeight,
					wasResized: false,
				};
			}
		}

		// Over the pixel budget: scale to fit, keeping the aspect ratio.
		let fitWidth = originalWidth;
		let fitHeight = originalHeight;
		if (fitWidth > opts.maxWidth) {
			fitHeight = Math.round((fitHeight * opts.maxWidth) / fitWidth);
			fitWidth = opts.maxWidth;
		}
		if (fitHeight > opts.maxHeight) {
			fitWidth = Math.round((fitWidth * opts.maxHeight) / fitHeight);
			fitHeight = opts.maxHeight;
		}
		if (overDims) {
			const resized = photon.resize(image, fitWidth, fitHeight, photon.SamplingFilter.Lanczos3);
			try {
				const candidate = encodeLadder(resized);
				if (candidate) {
					return {
						data: candidate.data,
						mimeType: candidate.mimeType,
						originalWidth,
						originalHeight,
						width: fitWidth,
						height: fitHeight,
						wasResized: true,
					};
				}
			} finally {
				resized.free();
			}
		}

		// Last resort, mirrors Claude Code: JPEG quality 20 at up-to-1000px
		// width, returned unconditionally so a decodable image is never
		// dropped — even if the result still exceeds maxBytes.
		const finalWidth = Math.min(fitWidth, 1000);
		const finalHeight = Math.max(1, Math.round((fitHeight * finalWidth) / Math.max(fitWidth, 1)));
		const lastResort = photon.resize(image, finalWidth, finalHeight, photon.SamplingFilter.Lanczos3);
		try {
			const candidate = encodeCandidate(lastResort.get_bytes_jpeg(20), "image/jpeg");
			return {
				data: candidate.data,
				mimeType: candidate.mimeType,
				originalWidth,
				originalHeight,
				width: finalWidth,
				height: finalHeight,
				wasResized: finalWidth !== originalWidth || finalHeight !== originalHeight,
			};
		} finally {
			lastResort.free();
		}
	} catch {
		// Photon loaded but failed on this image. A decodable in-budget image
		// already returned above, so this only rescues images Photon cannot
		// decode at all — and only when the header proves both budgets hold.
		return passthroughIfWithinLimits(inputBytes, mimeType, inputBase64Size, opts);
	} finally {
		if (image) {
			image.free();
		}
	}
}

/**
 * When Photon/WASM cannot be loaded — or loads but throws on this image — we
 * still want a compliant image to reach the model. Read raw pixel dimensions
 * from the container header and pass the original bytes through iff both the
 * pixel budget and the base64 budget are already satisfied. Anything oversized
 * returns null so the caller reports a real "cannot resize below the inline
 * limit" error instead of silently shipping an unbounded image.
 */
function passthroughIfWithinLimits(
	inputBytes: Uint8Array,
	mimeType: string,
	inputBase64Size: number,
	opts: Required<ImageResizeOptions>,
): ResizedImage | null {
	const dimensions = readImageDimensions(inputBytes);
	if (!dimensions) return null;
	if (dimensions.width > opts.maxWidth || dimensions.height > opts.maxHeight) return null;
	if (inputBase64Size > opts.maxBytes) return null;

	const format = mimeType.split("/")[1] ?? "png";
	return {
		data: Buffer.from(inputBytes).toString("base64"),
		mimeType: mimeType || `image/${format}`,
		originalWidth: dimensions.width,
		originalHeight: dimensions.height,
		width: dimensions.width,
		height: dimensions.height,
		wasResized: false,
	};
}
