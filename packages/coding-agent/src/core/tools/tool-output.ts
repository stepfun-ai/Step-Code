import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ImageContent, TextContent } from "@step-harness/providers";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./truncate.ts";

type Content = (TextContent | ImageContent)[];
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_SCAN_LIMIT = 100;
const OWNED_FILE = /^tool-[0-9a-f]{32}\.txt$/u;
// Built-in tools truncate to the same limits, then append a notice and, for
// bash, an exit status. Leave room for that trailer so a tail they kept on
// purpose is not cut by a second, head-only pass.
const PRODUCER_TRAILER_LINES = 8;
const PRODUCER_TRAILER_BYTES = 1024;

/** Bound final model-visible text while keeping the full textual view available on disk. */
export async function boundToolResultContent(
	content: Content,
	directory: string,
	signal?: AbortSignal,
): Promise<Content> {
	const text = content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const original = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES + PRODUCER_TRAILER_LINES,
		maxBytes: DEFAULT_MAX_BYTES + PRODUCER_TRAILER_BYTES,
	});
	if (!original.truncated) return content;

	signal?.throwIfAborted();
	const outputDirectory = resolve(directory);
	await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
	const path = join(outputDirectory, `tool-${randomBytes(16).toString("hex")}.txt`);
	const file = await open(path, "wx", 0o600);
	let written = false;
	try {
		await file.writeFile(text, { encoding: "utf8", signal });
		written = true;
	} finally {
		await file.close();
		if (!written) await unlink(path).catch(() => undefined);
	}

	const marker = (lines: number) =>
		`[Showing first ${lines} of ${original.totalLines} lines (${original.totalBytes} bytes total). Full output: ${JSON.stringify(path)}]`;
	const preview = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES - 2,
		maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(marker(DEFAULT_MAX_LINES), "utf8") - 2,
	});
	const bounded: Content = [];
	let offset = 0;
	let seenText = false;
	let marked = false;
	for (const part of content) {
		if (part.type !== "text") {
			bounded.push(part);
			continue;
		}
		const start = offset + (seenText ? 1 : 0);
		offset = start + part.text.length;
		seenText = true;
		if (marked) continue;
		// Include empty blocks at an exact boundary: they represent the final
		// newline in a retained prefix, and dropping one misreports shown lines.
		if (preview.outputLines > 0 && start <= preview.content.length) {
			const kept = part.text.slice(0, preview.content.length - start);
			bounded.push(kept === part.text ? part : { ...part, text: kept });
			if (offset <= preview.content.length) continue;
		}
		bounded.push({ type: "text", text: marker(preview.outputLines) });
		marked = true;
	}
	if (!marked) bounded.push({ type: "text", text: marker(preview.outputLines) });

	await cleanupExpiredOutput(outputDirectory, signal);
	return bounded;
}

/** Inspect a bounded part of this module's own namespace; cleanup never fails the tool. */
async function cleanupExpiredOutput(directory: string, signal?: AbortSignal): Promise<void> {
	try {
		const entries = await opendir(directory);
		let inspected = 0;
		for await (const entry of entries) {
			if (signal?.aborted || inspected++ >= CLEANUP_SCAN_LIMIT) break;
			if (!entry.isFile() || !OWNED_FILE.test(entry.name)) continue;
			const path = join(directory, entry.name);
			const stats = await lstat(path).catch(() => undefined);
			if (stats?.isFile() && stats.mtimeMs < Date.now() - RETENTION_MS) {
				await unlink(path).catch(() => undefined);
			}
		}
	} catch {
		// Retention remains useful if a concurrent cleanup or filesystem error prevents a sweep.
	}
}
