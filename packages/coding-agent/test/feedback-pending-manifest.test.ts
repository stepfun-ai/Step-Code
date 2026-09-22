import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { retryPendingFeedback } from "../src/step/feedback/delivery.ts";
import {
	normalizePendingFeedbackBundle,
	writePendingFeedback,
	writePendingFeedbackBundle,
} from "../src/step/feedback/pending-store.ts";
import { FEEDBACK_BUNDLE_MAX_BYTES, type FeedbackSubmission } from "../src/step/feedback/types.ts";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const TIMESTAMP = "2026-08-31T00:00:00.000Z";
const roots: string[] = [];

interface TarEntry {
	name: string;
	content: Buffer;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "step-feedback-pending-manifest-test-"));
	roots.push(root);
	return root;
}

function makeSubmission(): FeedbackSubmission {
	return {
		feedbackId: "11111111-1111-4111-8111-111111111111",
		category: "bug",
		comment: "It failed",
		at: TIMESTAMP,
		context: { channel: "test", version: "0.0.0", platform: "darwin" },
	};
}

function manifestContent(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function currentManifest(files: unknown): Record<string, unknown> {
	return {
		sessionId: "session-1",
		createdAt: TIMESTAMP,
		lastActivityAt: TIMESTAMP,
		files,
	};
}

async function makeCurrentArchive(payload: readonly TarEntry[], manifest: Buffer): Promise<Buffer> {
	return makeGzipTar([...payload, { name: "bundle.json", content: manifest }]);
}

async function makeLegacyArchive(manifest: unknown): Promise<Buffer> {
	return makeGzipTar([
		{ name: "session.jsonl", content: Buffer.from('{"type":"session"}\n') },
		{ name: "manifest.json", content: manifestContent(manifest) },
	]);
}

async function makeGzipTar(entries: readonly TarEntry[]): Promise<Buffer> {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const header = Buffer.alloc(512);
		Buffer.from(entry.name, "ascii").copy(header, 0, 0, 100);
		writeTarOctal(header, 100, 8, 0o600);
		writeTarOctal(header, 108, 8, 0);
		writeTarOctal(header, 116, 8, 0);
		writeTarOctal(header, 124, 12, entry.content.byteLength);
		writeTarOctal(header, 136, 12, Math.floor(Date.parse(TIMESTAMP) / 1000));
		header.fill(0x20, 148, 156);
		header[156] = 0x30;
		Buffer.from("ustar\0", "ascii").copy(header, 257);
		Buffer.from("00", "ascii").copy(header, 263);
		let checksum = 0;
		for (const byte of header) checksum += byte;
		writeTarOctal(header, 148, 8, checksum);
		blocks.push(header, entry.content);
		const padding = (512 - (entry.content.byteLength % 512)) % 512;
		if (padding > 0) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	return gzip(Buffer.concat(blocks));
}

function writeTarOctal(target: Buffer, offset: number, length: number, value: number): void {
	const text = `${value.toString(8)}\0`.padStart(length, "0").slice(-length);
	Buffer.from(text, "ascii").copy(target, offset, 0, length);
}

function addGzipMetadata(archive: Buffer, flag: 0x04 | 0x08 | 0x10, metadata: Buffer): Buffer {
	const header = Buffer.from(archive.subarray(0, 10));
	header[3] = (header[3] ?? 0) | flag;
	return Buffer.concat([header, metadata, archive.subarray(10)]);
}

async function makeNoncanonicalCurrentArchive(kind: "padding" | "ustar-header"): Promise<Buffer> {
	const events = Buffer.from('{"type":"session"}\n');
	const archive = await makeCurrentArchive(
		[{ name: "events.jsonl", content: events }],
		manifestContent(currentManifest([{ name: "events.jsonl", bytes: events.byteLength }])),
	);
	const tar = await gunzip(archive);
	if (kind === "padding") {
		tar[512 + events.byteLength] = 0x41;
	} else {
		Buffer.from("hidden-ustar-secret", "utf8").copy(tar, 265);
		const header = tar.subarray(0, 512);
		header.fill(0x20, 148, 156);
		let checksum = 0;
		for (const byte of header) checksum += byte;
		writeTarOctal(header, 148, 8, checksum);
	}
	return gzip(tar);
}

describe("pending current bundle manifest validation", () => {
	test("rejects malformed manifest JSON", async () => {
		const events = Buffer.from('{"type":"session"}\n');
		const archive = await makeCurrentArchive([{ name: "events.jsonl", content: events }], Buffer.from("{"));

		await expect(normalizePendingFeedbackBundle(archive)).resolves.toBeUndefined();
	});

	test("rejects invalid manifest roots, session identities, and timestamps", async () => {
		const events = Buffer.from('{"type":"session"}\n');
		const files = [{ name: "events.jsonl", bytes: events.byteLength }];
		const invalidManifests: unknown[] = [
			[],
			{ ...currentManifest(files), sessionId: "" },
			{ ...currentManifest(files), createdAt: "not-a-date" },
			{ ...currentManifest(files), lastActivityAt: "not-a-date" },
			{ ...currentManifest(files), files: {} },
		];

		for (const manifest of invalidManifests) {
			const archive = await makeCurrentArchive(
				[{ name: "events.jsonl", content: events }],
				manifestContent(manifest),
			);
			await expect(normalizePendingFeedbackBundle(archive)).resolves.toBeUndefined();
		}
	});

	test("rejects a descriptor whose byte count does not match its tar entry", async () => {
		const events = Buffer.from('{"type":"session"}\n');
		const archive = await makeCurrentArchive(
			[{ name: "events.jsonl", content: events }],
			manifestContent(currentManifest([{ name: "events.jsonl", bytes: events.byteLength + 1 }])),
		);

		await expect(normalizePendingFeedbackBundle(archive)).resolves.toBeUndefined();
	});

	test("rejects a manifest missing a payload descriptor", async () => {
		const events = Buffer.from('{"type":"session"}\n');
		const devLog = Buffer.from("Error: failed\n");
		const archive = await makeCurrentArchive(
			[
				{ name: "events.jsonl", content: events },
				{ name: "dev.log", content: devLog },
			],
			manifestContent(currentManifest([{ name: "events.jsonl", bytes: events.byteLength }])),
		);

		await expect(normalizePendingFeedbackBundle(archive)).resolves.toBeUndefined();
	});

	test("rejects a manifest with an extra payload descriptor", async () => {
		const events = Buffer.from('{"type":"session"}\n');
		const archive = await makeCurrentArchive(
			[{ name: "events.jsonl", content: events }],
			manifestContent(
				currentManifest([
					{ name: "events.jsonl", bytes: events.byteLength },
					{ name: "dev.log", bytes: 10 },
				]),
			),
		);

		await expect(normalizePendingFeedbackBundle(archive)).resolves.toBeUndefined();
	});

	test("rejects duplicate descriptors and non-string notes", async () => {
		const events = Buffer.from('{"type":"session"}\n');
		const devLog = Buffer.from("Error: failed\n");
		const duplicate = await makeCurrentArchive(
			[
				{ name: "events.jsonl", content: events },
				{ name: "dev.log", content: devLog },
			],
			manifestContent(
				currentManifest([
					{ name: "events.jsonl", bytes: events.byteLength },
					{ name: "events.jsonl", bytes: events.byteLength },
				]),
			),
		);
		const invalidNote = await makeCurrentArchive(
			[{ name: "events.jsonl", content: events }],
			manifestContent(currentManifest([{ name: "events.jsonl", bytes: events.byteLength, note: 42 }])),
		);

		await expect(normalizePendingFeedbackBundle(duplicate)).resolves.toBeUndefined();
		await expect(normalizePendingFeedbackBundle(invalidNote)).resolves.toBeUndefined();
	});

	test("accepts every compatible current entry and returns the archive unchanged", async () => {
		const payload = [
			{ name: "session.json", content: Buffer.from("{}\n") },
			{ name: "events.jsonl", content: Buffer.from('{"type":"session"}\n') },
			{ name: "resume.json", content: Buffer.from("{}\n") },
			{ name: "dev.log", content: Buffer.from("Error: failed\n") },
		] satisfies TarEntry[];
		const archive = await makeCurrentArchive(
			payload,
			manifestContent(
				currentManifest(
					payload.map((entry) => ({
						name: entry.name,
						bytes: entry.content.byteLength,
						...(entry.name === "dev.log" ? { note: "error context" } : {}),
					})),
				),
			),
		);

		await expect(normalizePendingFeedbackBundle(archive)).resolves.toBe(archive);
	});

	test("accepts a canonical current tar with an alternate valid compression level", async () => {
		const events = Buffer.from('{"type":"session"}\n');
		const archive = await makeCurrentArchive(
			[{ name: "events.jsonl", content: events }],
			manifestContent(currentManifest([{ name: "events.jsonl", bytes: events.byteLength }])),
		);
		const alternate = zlib.gzipSync(await gunzip(archive), { level: 0 });

		await expect(normalizePendingFeedbackBundle(alternate)).resolves.toBe(alternate);
	});

	test("rejects concatenated gzip members and trailing bytes", async () => {
		const events = Buffer.from('{"type":"session"}\n');
		const archive = await makeCurrentArchive(
			[{ name: "events.jsonl", content: events }],
			manifestContent(currentManifest([{ name: "events.jsonl", bytes: events.byteLength }])),
		);
		const extraMember = await gzip(Buffer.alloc(512));

		await expect(normalizePendingFeedbackBundle(Buffer.concat([archive, extraMember]))).resolves.toBeUndefined();
		await expect(normalizePendingFeedbackBundle(Buffer.concat([archive, Buffer.alloc(8)]))).resolves.toBeUndefined();
	});

	test("rejects corrupt or truncated single-member gzip framing", async () => {
		const events = Buffer.from('{"type":"session"}\n');
		const archive = await makeCurrentArchive(
			[{ name: "events.jsonl", content: events }],
			manifestContent(currentManifest([{ name: "events.jsonl", bytes: events.byteLength }])),
		);
		const badCrc = Buffer.from(archive);
		const crcOffset = badCrc.byteLength - 8;
		badCrc.writeUInt32LE((badCrc.readUInt32LE(crcOffset) ^ 1) >>> 0, crcOffset);
		const badSize = Buffer.from(archive);
		const sizeOffset = badSize.byteLength - 4;
		badSize.writeUInt32LE((badSize.readUInt32LE(sizeOffset) + 1) >>> 0, sizeOffset);

		for (const malformed of [
			badCrc,
			badSize,
			archive.subarray(0, -1),
			archive.subarray(0, -12),
			Buffer.concat([archive, Buffer.from([0])]),
		]) {
			await expect(normalizePendingFeedbackBundle(malformed)).resolves.toBeUndefined();
		}
	});

	test("rejects gzip metadata that is outside the consented tar manifest", async () => {
		const events = Buffer.from('{"type":"session"}\n');
		const archive = await makeCurrentArchive(
			[{ name: "events.jsonl", content: events }],
			manifestContent(currentManifest([{ name: "events.jsonl", bytes: events.byteLength }])),
		);
		const extra = Buffer.from("hidden-extra-secret", "utf8");
		const extraLength = Buffer.alloc(2);
		extraLength.writeUInt16LE(extra.byteLength);
		const archives = [
			addGzipMetadata(archive, 0x04, Buffer.concat([extraLength, extra])),
			addGzipMetadata(archive, 0x08, Buffer.from("hidden-name-secret\0", "utf8")),
			addGzipMetadata(archive, 0x10, Buffer.from("hidden-comment-secret\0", "utf8")),
		];

		for (const archiveWithMetadata of archives) {
			await expect(normalizePendingFeedbackBundle(archiveWithMetadata)).resolves.toBeUndefined();
		}
	});

	test.each(["padding", "ustar-header"] as const)(
		"rejects noncanonical tar %s bytes outside the consented manifest",
		async (kind) => {
			await expect(
				normalizePendingFeedbackBundle(await makeNoncanonicalCurrentArchive(kind)),
			).resolves.toBeUndefined();
		},
	);

	test("rejects a compressed member whose expanded tar exceeds the parser budget", async () => {
		const oversized = await gzip(Buffer.alloc(48 * 1024 * 1024 + 1));

		await expect(normalizePendingFeedbackBundle(oversized)).resolves.toBeUndefined();
	});

	test("reports an oversized pending archive as too-large without uploading it", async () => {
		const root = await makeRoot();
		const report = makeSubmission();
		const bodyPath = await writePendingFeedback({ storageRootDir: root, submission: report });
		const bundlePath = await writePendingFeedbackBundle({
			storageRootDir: root,
			feedbackId: report.feedbackId,
			data: Buffer.alloc(FEEDBACK_BUNDLE_MAX_BYTES + 1),
		});
		const calls: string[] = [];
		const fetchImpl: typeof fetch = async (input) => {
			calls.push(String(input));
			return new Response(null, { status: 204 });
		};

		const outcomes = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(calls).toEqual(["https://feedback.test/feedback"]);
		expect(outcomes).toMatchObject([
			{
				body: { status: "delivered" },
				bundle: { status: "pending", reason: "too-large", pendingPath: bundlePath },
			},
		]);
		await expect(stat(bodyPath)).resolves.toBeTruthy();
		await expect(stat(bundlePath)).resolves.toBeTruthy();
	});

	test("keeps a concatenated pending bundle unchanged and never uploads it", async () => {
		const root = await makeRoot();
		const report = makeSubmission();
		const events = Buffer.from('{"type":"session"}\n');
		const archive = await makeCurrentArchive(
			[{ name: "events.jsonl", content: events }],
			manifestContent(currentManifest([{ name: "events.jsonl", bytes: events.byteLength }])),
		);
		const concatenated = Buffer.concat([archive, await gzip(Buffer.alloc(512))]);
		const bodyPath = await writePendingFeedback({ storageRootDir: root, submission: report });
		const bundlePath = await writePendingFeedbackBundle({
			storageRootDir: root,
			feedbackId: report.feedbackId,
			data: concatenated,
		});
		const calls: string[] = [];
		const fetchImpl: typeof fetch = async (input) => {
			calls.push(String(input));
			return new Response(null, { status: 204 });
		};

		const outcomes = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(calls).toEqual(["https://feedback.test/feedback"]);
		expect(outcomes).toMatchObject([
			{ body: { status: "delivered" }, bundle: { status: "pending", reason: "rejected" } },
		]);
		await expect(stat(bodyPath)).resolves.toBeTruthy();
		await expect(stat(bundlePath)).resolves.toBeTruthy();
		await expect(readFile(bundlePath)).resolves.toEqual(concatenated);
	});

	test("keeps a metadata-bearing pending bundle unchanged and never uploads it", async () => {
		const root = await makeRoot();
		const report = makeSubmission();
		const events = Buffer.from('{"type":"session"}\n');
		const archive = await makeCurrentArchive(
			[{ name: "events.jsonl", content: events }],
			manifestContent(currentManifest([{ name: "events.jsonl", bytes: events.byteLength }])),
		);
		const metadataArchive = addGzipMetadata(archive, 0x08, Buffer.from("hidden-name-secret\0", "utf8"));
		const bodyPath = await writePendingFeedback({ storageRootDir: root, submission: report });
		const bundlePath = await writePendingFeedbackBundle({
			storageRootDir: root,
			feedbackId: report.feedbackId,
			data: metadataArchive,
		});
		const calls: string[] = [];
		const fetchImpl: typeof fetch = async (input) => {
			calls.push(String(input));
			return new Response(null, { status: 204 });
		};

		const outcomes = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(calls).toEqual(["https://feedback.test/feedback"]);
		expect(outcomes).toMatchObject([
			{ body: { status: "delivered" }, bundle: { status: "pending", reason: "rejected" } },
		]);
		await expect(stat(bodyPath)).resolves.toBeTruthy();
		await expect(stat(bundlePath)).resolves.toBeTruthy();
		await expect(readFile(bundlePath)).resolves.toEqual(metadataArchive);
	});

	test.each(["padding", "ustar-header"] as const)(
		"keeps a pending bundle with noncanonical tar %s unchanged and never uploads it",
		async (kind) => {
			const root = await makeRoot();
			const report = makeSubmission();
			const archive = await makeNoncanonicalCurrentArchive(kind);
			const bodyPath = await writePendingFeedback({ storageRootDir: root, submission: report });
			const bundlePath = await writePendingFeedbackBundle({
				storageRootDir: root,
				feedbackId: report.feedbackId,
				data: archive,
			});
			const calls: string[] = [];
			const fetchImpl: typeof fetch = async (input) => {
				calls.push(String(input));
				return new Response(null, { status: 204 });
			};

			const outcomes = await retryPendingFeedback({
				endpoint: "https://feedback.test/feedback",
				bundleEndpoint: "https://feedback.test/bundle",
				storageRootDir: root,
				fetchImpl,
				retryBackoffsMs: [],
			});

			expect(calls).toEqual(["https://feedback.test/feedback"]);
			expect(outcomes).toMatchObject([
				{ body: { status: "delivered" }, bundle: { status: "pending", reason: "rejected" } },
			]);
			await expect(stat(bodyPath)).resolves.toBeTruthy();
			await expect(stat(bundlePath)).resolves.toBeTruthy();
			await expect(readFile(bundlePath)).resolves.toEqual(archive);
		},
	);

	test("keeps the pending pair and never fetches the bundle when its manifest is invalid", async () => {
		const root = await makeRoot();
		const report = makeSubmission();
		const events = Buffer.from('{"type":"session"}\n');
		const archive = await makeCurrentArchive(
			[{ name: "events.jsonl", content: events }],
			manifestContent(currentManifest([{ name: "events.jsonl", bytes: events.byteLength + 1 }])),
		);
		const bodyPath = await writePendingFeedback({ storageRootDir: root, submission: report });
		const bundlePath = await writePendingFeedbackBundle({
			storageRootDir: root,
			feedbackId: report.feedbackId,
			data: archive,
		});
		const calls: string[] = [];
		const fetchImpl: typeof fetch = async (input) => {
			calls.push(String(input));
			return new Response(null, { status: 204 });
		};

		const outcomes = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(calls).toEqual(["https://feedback.test/feedback"]);
		expect(outcomes).toMatchObject([
			{ body: { status: "delivered" }, bundle: { status: "pending", reason: "rejected" } },
		]);
		await expect(stat(bodyPath)).resolves.toBeTruthy();
		await expect(stat(bundlePath)).resolves.toBeTruthy();
		await expect(readFile(bundlePath)).resolves.toEqual(archive);
	});
});

describe("pending legacy bundle manifest validation", () => {
	test("accepts the exact legacy shape with a supported file note", async () => {
		const note = "tail only, 30.0 MB on disk";
		const archive = await makeLegacyArchive({
			sessionId: "legacy-session",
			createdAt: TIMESTAMP,
			lastActivityAt: TIMESTAMP,
			files: [{ name: "session.jsonl", bytes: 19, note }],
		});

		await expect(normalizePendingFeedbackBundle(archive)).resolves.toBeInstanceOf(Buffer);
	});

	test("rejects unknown root and file descriptor fields", async () => {
		const baseManifest = {
			sessionId: "legacy-session",
			createdAt: TIMESTAMP,
			lastActivityAt: TIMESTAMP,
			files: [{ name: "session.jsonl", bytes: 19 }],
		};
		const archives = await Promise.all([
			makeLegacyArchive({ ...baseManifest, source: "future-client" }),
			makeLegacyArchive({
				...baseManifest,
				files: [{ name: "session.jsonl", bytes: 19, checksum: "untrusted" }],
			}),
		]);

		for (const archive of archives) {
			await expect(normalizePendingFeedbackBundle(archive)).resolves.toBeUndefined();
		}
	});
});
