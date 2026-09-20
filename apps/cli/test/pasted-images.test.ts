import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PastedImageRegistry, resolvePastedImages } from "../src/ui/runtime/pasted-images.ts";

// A tiny 2x2 red PNG (base64) — a real, decodable image so resolvePastedImages
// can run the actual imageFileToContent path.
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

describe("PastedImageRegistry", () => {
	it("numbers pasted images from 1, incrementing within a message", () => {
		const registry = new PastedImageRegistry();
		expect(registry.register("/tmp/a.png")).toBe(1);
		expect(registry.register("/tmp/b.png")).toBe(2);
		expect(registry.register("/tmp/c.png")).toBe(3);
	});

	it("scans the placeholders present in the text, in first-appearance order", () => {
		const registry = new PastedImageRegistry();
		registry.register("/tmp/a.png"); // #1
		registry.register("/tmp/b.png"); // #2
		registry.register("/tmp/c.png"); // #3

		// Only #3 and #1 are still in the text, in that order.
		expect(registry.scan("look at [Image #3] and [Image #1] please")).toEqual([
			{ index: 3, path: "/tmp/c.png" },
			{ index: 1, path: "/tmp/a.png" },
		]);
	});

	it("de-duplicates a placeholder repeated in the text", () => {
		const registry = new PastedImageRegistry();
		registry.register("/tmp/a.png"); // #1

		expect(registry.scan("[Image #1] again [Image #1]")).toEqual([{ index: 1, path: "/tmp/a.png" }]);
	});

	it("ignores placeholders whose number was never registered", () => {
		const registry = new PastedImageRegistry();
		registry.register("/tmp/a.png"); // #1

		expect(registry.scan("[Image #1] and [Image #9]")).toEqual([{ index: 1, path: "/tmp/a.png" }]);
	});

	it("returns nothing when the text has no placeholders", () => {
		const registry = new PastedImageRegistry();
		registry.register("/tmp/a.png");

		expect(registry.scan("just some text")).toEqual([]);
	});

	it("resets the counter and clears the map so the next message starts at #1", () => {
		const registry = new PastedImageRegistry();
		registry.register("/tmp/a.png"); // #1
		registry.register("/tmp/b.png"); // #2
		registry.reset();

		expect(registry.register("/tmp/c.png")).toBe(1);
		// The pre-reset entries are gone; only the new #1 resolves.
		expect(registry.scan("[Image #1] [Image #2]")).toEqual([{ index: 1, path: "/tmp/c.png" }]);
	});
});

describe("resolvePastedImages", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "resolve-pasted-images-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writePng(name: string): string {
		const filePath = join(dir, name);
		writeFileSync(filePath, Buffer.from(TINY_PNG, "base64"));
		return filePath;
	}

	it("resolves a placeholder to an attachment, keeps the text, and resets the registry", async () => {
		const registry = new PastedImageRegistry();
		const n = registry.register(writePng("a.png"));

		const { text, images } = await resolvePastedImages(registry, `[Image #${n}] describe this`, {
			autoResizeImages: false,
		});

		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(text).toBe("[Image #1] describe this"); // resolved placeholder is preserved for the transcript
		// Registry reset: a fresh paste is #1 again and the old entry is gone.
		expect(registry.register("/tmp/next.png")).toBe(1);
	});

	it("strips a placeholder that fails to resolve so the model gets no dangling [Image #N]", async () => {
		const registry = new PastedImageRegistry();
		const notAnImage = join(dir, "notes.txt");
		writeFileSync(notAnImage, "plain text, not an image");
		const n = registry.register(notAnImage);

		const { text, images } = await resolvePastedImages(registry, `[Image #${n}] look here`, {
			autoResizeImages: false,
		});

		expect(images).toEqual([]);
		expect(text).toBe("look here"); // dangling placeholder removed
	});

	it("keeps resolved placeholders and drops only the failed ones", async () => {
		const registry = new PastedImageRegistry();
		const good = registry.register(writePng("good.png")); // #1
		const bad = join(dir, "bad.txt");
		writeFileSync(bad, "nope");
		const failed = registry.register(bad); // #2

		const { text, images } = await resolvePastedImages(registry, `[Image #${good}] and [Image #${failed}]`, {
			autoResizeImages: false,
		});

		expect(images).toHaveLength(1);
		expect(text).toBe("[Image #1] and "); // #1 kept, #2 stripped
	});

	it("leaves text untouched and returns no images when there are no placeholders", async () => {
		const registry = new PastedImageRegistry();
		const { text, images } = await resolvePastedImages(registry, "no images here", { autoResizeImages: false });
		expect(images).toEqual([]);
		expect(text).toBe("no images here");
	});
});
