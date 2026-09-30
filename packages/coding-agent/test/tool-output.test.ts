import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { ImageContent, TextContent } from "@step-harness/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundToolResultContent } from "../src/core/tools/tool-output.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/core/tools/truncate.ts";

type Content = (TextContent | ImageContent)[];
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "step-tool-output-test-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function text(content: Content) {
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
function artifact(content: Content) {
	const match = text(content).match(/Full output: (.+)\]/);
	expect(match).not.toBeNull();
	return JSON.parse(match![1]) as string;
}

it("does not create storage for an unchanged small result", async () => {
	const content: Content = [{ type: "text", text: "small" }];
	expect(await boundToolResultContent(content, join(root, "not-created"))).toBe(content);
	expect(await readdir(root)).toEqual([]);
});

it("returns an absolute readable artifact path for a relative storage directory", async () => {
	const content = await boundToolResultContent(
		[{ type: "text", text: "x".repeat(60000) }],
		relative(process.cwd(), join(root, "relative")),
	);
	expect(isAbsolute(artifact(content))).toBe(true);
	expect(await readFile(artifact(content), "utf8")).toBe("x".repeat(60000));
});

it("bounds combined text while preserving image identity and ordering", async () => {
	const first: ImageContent = { type: "image", data: "first", mimeType: "image/png" };
	const second: ImageContent = { type: "image", data: "second", mimeType: "image/png" };
	const a = "α\n".repeat(1500);
	const b = "中文\n".repeat(1500);
	const result = await boundToolResultContent(
		[{ type: "text", text: a }, first, { type: "text", text: b }, second],
		root,
	);
	const images = result.filter((part) => part.type === "image");
	expect(images).toEqual([first, second]);
	expect(images[0]).toBe(first);
	expect(images[1]).toBe(second);
	expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	expect(text(result).split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
	expect(await readFile(artifact(result), "utf8")).toBe(`${a}\n${b}`);
});

it("accounts for empty text blocks in the preview line count", async () => {
	const result = await boundToolResultContent(
		Array.from({ length: 3001 }, () => ({ type: "text", text: "" })),
		root,
	);
	const texts = result.filter((part) => part.type === "text");
	const notice = texts.at(-1)!.text;
	const shown = Number(notice.match(/Showing first (\d+)/)![1]);
	expect(text(texts.slice(0, -1))).toBe("\n".repeat(shown - 1));
	expect(text(result).split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
});

it("retains a UTF-8-safe prefix and the entire multibyte source", async () => {
	const original = "🙂中文\n".repeat(10000);
	const result = await boundToolResultContent([{ type: "text", text: original }], root);
	expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	expect(text(result)).not.toContain("\uFFFD");
	expect(await readFile(artifact(result), "utf8")).toBe(original);
});

it("honors cancellation before creating an artifact", async () => {
	const controller = new AbortController();
	controller.abort(new Error("user cancelled"));
	await expect(
		boundToolResultContent([{ type: "text", text: "x".repeat(60000) }], join(root, "cancelled"), controller.signal),
	).rejects.toThrow("user cancelled");
	expect(await readdir(root)).toEqual([]);
});

it("does not claim retention succeeded when storage is unavailable", async () => {
	const directory = join(root, "not-a-directory");
	await writeFile(directory, "keep");
	await expect(boundToolResultContent([{ type: "text", text: "x".repeat(60000) }], directory)).rejects.toThrow();
	expect(await readFile(directory, "utf8")).toBe("keep");
});

it("creates distinct private artifacts for repeated calls", async () => {
	const directory = join(root, "private");
	const content: Content = [{ type: "text", text: "x".repeat(60000) }];
	const results = await Promise.all([
		boundToolResultContent(content, directory),
		boundToolResultContent(content, directory),
	]);
	const files = results.map(artifact);
	expect(files[0]).not.toBe(files[1]);
	if (process.platform !== "win32") {
		for (const file of files) expect((await stat(file)).mode & 0o077).toBe(0);
		expect((await stat(directory)).mode & 0o077).toBe(0);
	}
});

describe("owned artifact retention", () => {
	it("cleans expired owned files without following symlinks or removing unrelated files", async () => {
		const directory = join(root, "output");
		await mkdir(directory);
		const expired = join(directory, `tool-${"a".repeat(32)}.txt`);
		const unrelated = join(directory, "notes.txt");
		const outside = join(root, "outside.txt");
		await Promise.all([writeFile(expired, "old"), writeFile(unrelated, "keep"), writeFile(outside, "outside")]);
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		await Promise.all([utimes(expired, old, old), utimes(unrelated, old, old)]);
		if (process.platform !== "win32") await symlink(outside, join(directory, `tool-${"b".repeat(32)}.txt`));
		const result = await boundToolResultContent([{ type: "text", text: "x".repeat(60000) }], directory);
		await expect(stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(unrelated, "utf8")).toBe("keep");
		expect(await readFile(outside, "utf8")).toBe("outside");
		expect(await readFile(artifact(result), "utf8")).toBe("x".repeat(60000));
	});
});

it("keeps the notice within the line budget when the artifact path contains line breaks", async () => {
	if (process.platform === "win32") return;
	const directory = join(root, "part\none\ntwo\nthree");
	const original = "line\n".repeat(2500);
	const result = await boundToolResultContent([{ type: "text", text: original }], directory);
	expect(text(result).split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
	const encodedPath = text(result).match(/Full output: (.+)\]/)![1];
	expect(await readFile(JSON.parse(encodedPath), "utf8")).toBe(original);
});

it("keeps a retained empty first line consistent with the notice", async () => {
	const original = `\n${"x".repeat(60000)}`;
	const result = await boundToolResultContent([{ type: "text", text: original }], root);
	expect(text(result)).toMatch(/^\n\[Showing first 1 of 2 lines/);
});

it("leaves a producer's own truncation notice and exit status in place", async () => {
	// Native bash keeps the last 2,000 lines, then appends its notice and status.
	const kept = Array.from({ length: DEFAULT_MAX_LINES }, (_, n) => `line ${n + 1001}`).join("\n");
	const original = `${kept}\n\n[Showing lines 1001-3000 of 3000. Full output: /tmp/step-bash-0123456789abcdef.log]\n\nCommand exited with code 1`;
	const content: Content = [{ type: "text", text: original }];
	expect(await boundToolResultContent(content, join(root, "not-created"))).toBe(content);
	expect(await readdir(root)).toEqual([]);
});

it("still bounds output that exceeds the room left for a producer trailer", async () => {
	const original = "line\n".repeat(DEFAULT_MAX_LINES + 20);
	const result = await boundToolResultContent([{ type: "text", text: original }], root);
	expect(text(result).split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
	expect(await readFile(artifact(result), "utf8")).toBe(original);
});
