/**
 * pasted-images.ts — the pasted-image placeholder registry and its resolver.
 *
 * When an image is pasted into the composer we no longer insert its (long, ugly)
 * temp-file path as an `@` reference. Instead we insert a `[Image #N]` placeholder
 * and remember, here, which absolute file path each display number maps to. When
 * the message is dispatched to the model, resolvePastedImages() turns the
 * placeholders in the outgoing text back into real image attachments.
 *
 * The display counter resets per message: after a message is sent the registry is
 * reset, so the next message's first pasted image is `[Image #1]` again. Because
 * numbers are reused across messages, the map is cleared together with the counter
 * — a message must resolve (which snapshots then resets) before the next paste.
 *
 * The registry itself is a pure data structure (register/scan/reset, unit-tested
 * in isolation); the file reading lives in the resolvePastedImages() helper so
 * every submit path shares ONE implementation instead of re-inlining collect +
 * reset + read.
 */

import { imageFileToContent } from "@step-harness/coding-agent";
import type { ImageContent } from "@step-harness/providers";

/** Matches the `[Image #N]` placeholders inserted on paste. */
const IMAGE_PLACEHOLDER_REGEX = /\[Image #(\d+)\]/g;
/** Same, but also eats one trailing space so stripping leaves no double gap. */
const IMAGE_PLACEHOLDER_STRIP_REGEX = /\[Image #(\d+)\] ?/g;

export type PastedImageEntry = { index: number; path: string };

export class PastedImageRegistry {
	private counter = 0;
	private paths = new Map<number, string>();

	/**
	 * Record a pasted image and return its display number (1-based, incrementing
	 * within the current message). The caller inserts `[Image #<n>]` into the editor.
	 */
	register(absolutePath: string): number {
		this.counter += 1;
		this.paths.set(this.counter, absolutePath);
		return this.counter;
	}

	/**
	 * Synchronously pick the `[Image #k]` placeholders still present in `text` that
	 * are registered, de-duplicated and ordered by first appearance, as
	 * {index, path}. Placeholders whose number is not (or no longer) registered are
	 * ignored. Pure — does not mutate; pair it with reset() with no await between.
	 */
	scan(text: string): PastedImageEntry[] {
		const seen = new Set<number>();
		const result: PastedImageEntry[] = [];
		for (const match of text.matchAll(IMAGE_PLACEHOLDER_REGEX)) {
			const index = Number(match[1]);
			if (seen.has(index)) continue;
			seen.add(index);
			const path = this.paths.get(index);
			if (path !== undefined) result.push({ index, path });
		}
		return result;
	}

	/** Clear the map and reset the display counter. Call after a message is sent. */
	reset(): void {
		this.counter = 0;
		this.paths.clear();
	}
}

export type ResolvedPastedImages = {
	/** The message text to send, with any placeholders that FAILED to resolve removed. */
	text: string;
	/** Attachments for the placeholders that resolved successfully, in order. */
	images: ImageContent[];
};

/**
 * Resolve the `[Image #N]` placeholders in an outgoing message to attached images,
 * and reset the registry for the next message. This is the single resolution path
 * shared by every submit site (main loop, steer, follow-up, compaction queue).
 *
 * scan() + reset() run synchronously with no await between them, so a paste landing
 * mid-resolve cannot be mis-numbered; the file reads run afterwards on the snapshot.
 * A placeholder that fails to read (unsupported/too-large/missing file) is dropped
 * from `text` so the model never receives a dangling `[Image #N]` with no image.
 */
export async function resolvePastedImages(
	registry: PastedImageRegistry,
	text: string,
	opts: { autoResizeImages: boolean },
): Promise<ResolvedPastedImages> {
	const entries = registry.scan(text);
	registry.reset();
	if (entries.length === 0) return { text, images: [] };

	const images: ImageContent[] = [];
	const failed: number[] = [];
	for (const { index, path } of entries) {
		const content = await imageFileToContent(path, opts);
		if (content) images.push(content);
		else failed.push(index);
	}

	if (failed.length === 0) return { text, images };

	const drop = new Set(failed);
	const cleaned = text.replace(IMAGE_PLACEHOLDER_STRIP_REGEX, (match, n) => (drop.has(Number(n)) ? "" : match));
	return { text: cleaned, images };
}
