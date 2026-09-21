import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { buildFeedbackSessionBundle, describeFeedbackBundle } from "../src/step/feedback/bundle.ts";
import { formatFeedbackSubmittedMessage, parseFeedbackArgs, runFeedbackCommand } from "../src/step/feedback/command.ts";
import { deliverFeedback, retryPendingFeedback } from "../src/step/feedback/delivery.ts";
import { readFeedbackDiagnostics } from "../src/step/feedback/diagnostics.ts";
import { resolveFeedbackEndpoint } from "../src/step/feedback/endpoints.ts";
import {
	listPendingFeedback,
	resolveFeedbackPendingPath,
	writePendingFeedback,
	writePendingFeedbackBundle,
} from "../src/step/feedback/pending-store.ts";
import { resolveFeedbackSettings } from "../src/step/feedback/settings.ts";
import { buildFeedbackSubmission } from "../src/step/feedback/submission.ts";
import {
	FEEDBACK_BUNDLE_MAX_BYTES,
	FEEDBACK_COMMENT_MAX_RUNES,
	FEEDBACK_DIAGNOSTICS_MAX_LINE_CHARS,
	FEEDBACK_DIAGNOSTICS_MAX_LINES,
	type FeedbackSubmission,
} from "../src/step/feedback/types.ts";
import {
	boundFeedbackDiagnosticsLines,
	excerptFeedbackDiagnostics,
	normalizeFeedbackCategory,
	validateFeedbackInput,
} from "../src/step/feedback/validate.ts";
import { appendStderrDevLog, createStderrMirrorWrite, resolveStderrDevLogPath } from "../src/step/stderr-dev-log.ts";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "step-feedback-test-"));
	roots.push(root);
	return root;
}

function submission(feedbackId = "11111111-1111-4111-8111-111111111111"): FeedbackSubmission {
	return {
		feedbackId,
		category: "bug",
		comment: "It failed",
		at: "2026-08-31T00:00:00.000Z",
		context: { channel: "test", version: "0.0.0", platform: "darwin" },
	};
}

function response(status: number): Response {
	return new Response(null, { status });
}

function queuedFetch(items: readonly (Response | Error)[]): {
	fetchImpl: typeof fetch;
	calls: Array<{ url: string; init?: RequestInit }>;
} {
	let index = 0;
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		calls.push({ url: String(input), init });
		const item = items[Math.min(index++, items.length - 1)];
		if (item instanceof Error) throw item;
		return item;
	};
	return { fetchImpl, calls };
}

function captureOutput(): { stream: Writable; text: () => string } {
	const chunks: string[] = [];
	return {
		stream: new Writable({
			write(chunk, _encoding, callback) {
				chunks.push(String(chunk));
				callback();
			},
		}),
		text: () => chunks.join(""),
	};
}

interface TarEntry {
	name: string;
	content: Buffer;
}

async function readBundleEntries(data: Uint8Array): Promise<TarEntry[]> {
	const tar = await gunzip(data);
	const entries: TarEntry[] = [];
	for (let offset = 0; offset + 512 <= tar.byteLength; ) {
		const header = tar.subarray(offset, offset + 512);
		const name = readTarString(header, 0, 100);
		if (!name) break;
		const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
		const contentStart = offset + 512;
		entries.push({ name, content: Buffer.from(tar.subarray(contentStart, contentStart + size)) });
		offset = contentStart + Math.ceil(size / 512) * 512;
	}
	return entries;
}

async function makeGzipTar(entries: readonly TarEntry[], at = new Date("2026-08-31T00:00:00.000Z")): Promise<Buffer> {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const header = Buffer.alloc(512);
		Buffer.from(entry.name, "ascii").copy(header, 0, 0, 100);
		writeTarOctal(header, 100, 8, 0o600);
		writeTarOctal(header, 108, 8, 0);
		writeTarOctal(header, 116, 8, 0);
		writeTarOctal(header, 124, 12, entry.content.byteLength);
		writeTarOctal(header, 136, 12, Math.floor(at.getTime() / 1000));
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

function readTarString(buffer: Buffer, offset: number, length: number): string {
	return buffer
		.subarray(offset, offset + length)
		.toString("utf8")
		.replace(/\0.*$/u, "");
}

function writeTarOctal(target: Buffer, offset: number, length: number, value: number): void {
	const text = `${value.toString(8)}\0`.padStart(length, "0").slice(-length);
	Buffer.from(text, "ascii").copy(target, offset, 0, length);
}

async function makeCurrentBundle(root: string): Promise<Buffer> {
	const sessionFile = join(root, `20260831_${crypto.randomUUID()}.jsonl`);
	await writeFile(sessionFile, '{"type":"session"}\n');
	const result = await buildFeedbackSessionBundle({ storageRootDir: root, sessionFile });
	if (result.status !== "ready") throw new Error(`expected a feedback bundle, got ${result.reason}`);
	return Buffer.from(result.bundle.data);
}

async function makeLegacyBundle(note?: unknown): Promise<Buffer> {
	const events = Buffer.from('{"type":"session"}\n', "utf8");
	const manifest = {
		sessionId: "legacy-session",
		createdAt: "2026-08-31T00:00:00.000Z",
		lastActivityAt: "2026-08-31T00:00:00.000Z",
		files: [{ name: "session.jsonl", bytes: events.byteLength, ...(note === undefined ? {} : { note }) }],
	};
	return makeGzipTar([
		{ name: "session.jsonl", content: events },
		{ name: "manifest.json", content: Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8") },
	]);
}

describe("feedback validation and settings", () => {
	test("normalizes CLI category spellings and rejects unknown values", () => {
		expect(normalizeFeedbackCategory(" bad-result ")).toBe("bad_result");
		expect(normalizeFeedbackCategory("safety check")).toBe("safety_check");
		expect(normalizeFeedbackCategory("not-a-category")).toBeUndefined();
		expect(validateFeedbackInput({ category: "typo", comment: "x" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("Unknown feedback category"),
		});
	});

	test("counts Unicode code points and trims the comment", () => {
		expect(validateFeedbackInput({ comment: "  好的  " })).toEqual({ ok: true, comment: "好的" });
		expect(validateFeedbackInput({ comment: "😀".repeat(FEEDBACK_COMMENT_MAX_RUNES + 1) }).ok).toBe(false);
	});

	test("bounds diagnostics newest-first within the line budget", () => {
		const lines = Array.from({ length: 50 }, (_, index) => `line-${index}`);
		const bounded = boundFeedbackDiagnosticsLines(lines);
		expect(bounded.lines).toHaveLength(FEEDBACK_DIAGNOSTICS_MAX_LINES);
		// The newest line survives and the oldest is dropped: the failure being reported
		// is the last thing that happened.
		expect(bounded.lines.at(-1)).toBe("line-49");
		expect(bounded.lines[0]).toBe(`line-${50 - FEEDBACK_DIAGNOSTICS_MAX_LINES}`);
		expect(bounded.truncated).toBe(true);
	});

	test("excerpts strip ANSI, clamp long lines, and keep trace notes far from EOF", () => {
		const clamped = excerptFeedbackDiagnostics({
			lines: [`\u001b[31m${"x".repeat(600)}\u001b[0m`],
			source: "stderr_dev_log",
			startsMidStream: false,
		});
		expect(clamped.lines[0]).toBe("x".repeat(FEEDBACK_DIAGNOSTICS_MAX_LINE_CHARS));
		expect(clamped.truncated).toBe(true);

		// The one note row sits at the top, far from the newest lines; the input_trace
		// priority pass must keep it rather than filling the budget with keystroke noise.
		const trace = [
			'{"src":"note","msg":"raw-without-dispatch"}',
			...Array.from({ length: 60 }, (_, index) => `{"src":"raw","i":${index}}`),
		];
		const bounded = excerptFeedbackDiagnostics({ lines: trace, source: "input_trace", startsMidStream: false });
		expect(bounded.lines.some((line) => line.includes("raw-without-dispatch"))).toBe(true);
	});

	test("honors environment opt-out before persisted settings", () => {
		expect(resolveFeedbackSettings({ env: {}, settings: {} })).toEqual({ enabled: true });
		expect(resolveFeedbackSettings({ env: { STEPCODE_DISABLE_FEEDBACK: "true" }, settings: {} })).toEqual({
			enabled: false,
			reason: "env-opt-out",
		});
		expect(resolveFeedbackSettings({ env: {}, settings: { feedbackEnabled: false } })).toEqual({
			enabled: false,
			reason: "config-opt-out",
		});
	});

	test("requires explicit endpoints and accepts environment aliases", () => {
		expect(resolveFeedbackEndpoint({})).toBeUndefined();
		expect(resolveFeedbackEndpoint({ STEP_HARNESS_FEEDBACK_ENDPOINT: " https://feedback.test " })).toBe(
			"https://feedback.test",
		);
		expect(
			resolveFeedbackEndpoint({ STEP_HARNESS_FEEDBACK_BUNDLE_ENDPOINT: "https://feedback.test/bundle" }, true),
		).toBe("https://feedback.test/bundle");
		expect(resolveFeedbackEndpoint({ STEP_HARNESS_FEEDBACK_ENDPOINT: " https://feedback.test " })).toBe(
			"https://feedback.test",
		);
	});
});

describe("feedback submission and delivery", () => {
	test("redacts comment content and preserves injected context", async () => {
		const root = await makeRoot();
		const result = await buildFeedbackSubmission({
			category: "good-result",
			comment: "see https://example.com/report and key sk-abcdefghijklmnop",
			storageRootDir: root,
			sessionId: "session-1",
			env: { STEP_HARNESS_BUILD_CHANNEL: "release", STEP_HARNESS_BUILD_COMMIT: "abc123" },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.submission.comment).toContain("<redacted:secret>");
		// Credential-shaped redaction, not telemetry redaction: the user's own URL survives.
		expect(result.submission.comment).toContain("https://example.com/report");
		expect(result.submission.comment).not.toContain("sk-abcdefghijklmnop");
		expect(result.submission.category).toBe("good_result");
		expect(result.submission.context).toMatchObject({ channel: "release", commit: "abc123", sessionId: "session-1" });
	});

	test("delivers a body on a 2xx response", async () => {
		const root = await makeRoot();
		const { fetchImpl, calls } = queuedFetch([response(204)]);
		const result = await deliverFeedback({
			endpoint: "https://feedback.test/feedback",
			submission: submission(),
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});
		expect(result).toEqual({ status: "delivered", feedbackId: submission().feedbackId });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
	});

	test.each([
		[404, "unsupported-endpoint"],
		[413, "too-large"],
		[422, "rejected"],
	] as const)("persists a body for permanent HTTP status %s", async (status, reason) => {
		const root = await makeRoot();
		const result = await deliverFeedback({
			endpoint: "https://feedback.test/feedback",
			submission: submission(),
			storageRootDir: root,
			fetchImpl: queuedFetch([response(status)]).fetchImpl,
			retryBackoffsMs: [],
		});
		expect(result.status).toBe("pending");
		if (result.status !== "pending") return;
		expect(result.reason).toBe(reason);
		expect(result.pendingPath).toBeDefined();
		await expect(stat(result.pendingPath!)).resolves.toBeTruthy();
	});

	test("retries 5xx responses but not transport failures", async () => {
		const root = await makeRoot();
		const sleeps: number[] = [];
		const first = queuedFetch([response(503), response(204)]);
		const delivered = await deliverFeedback({
			endpoint: "https://feedback.test/feedback",
			submission: submission(),
			storageRootDir: root,
			fetchImpl: first.fetchImpl,
			retryBackoffsMs: [7],
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(delivered.status).toBe("delivered");
		expect(first.calls).toHaveLength(2);
		expect(sleeps).toEqual([7]);

		const network = queuedFetch([new Error("offline"), response(204)]);
		const networkSleeps: number[] = [];
		const networkResult = await deliverFeedback({
			endpoint: "https://feedback.test/feedback",
			submission: submission("22222222-2222-4222-8222-222222222222"),
			storageRootDir: root,
			fetchImpl: network.fetchImpl,
			retryBackoffsMs: [3],
			sleep: async (ms) => {
				networkSleeps.push(ms);
			},
		});
		expect(networkResult).toMatchObject({ status: "pending", reason: "unreachable" });
		expect(network.calls).toHaveLength(1);
		expect(networkSleeps).toEqual([]);
	});

	test("retries HTTP 429 after the configured backoff and succeeds", async () => {
		const root = await makeRoot();
		const sleeps: number[] = [];
		const { fetchImpl, calls } = queuedFetch([response(429), response(204)]);
		const result = await deliverFeedback({
			endpoint: "https://feedback.test/feedback",
			submission: submission(),
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [13],
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});

		expect(result).toEqual({ status: "delivered", feedbackId: submission().feedbackId });
		expect(calls).toHaveLength(2);
		expect(sleeps).toEqual([13]);
	});

	test("keeps a recoverable bundle when its upload fails", async () => {
		const root = await makeRoot();
		const id = submission().feedbackId;
		const result = await deliverFeedback({
			endpoint: "https://feedback.test/feedback",
			submission: submission(),
			storageRootDir: root,
			bundle: { endpoint: "https://feedback.test/bundle", data: Buffer.from("archive") },
			fetchImpl: queuedFetch([response(204), response(500)]).fetchImpl,
			retryBackoffsMs: [],
		});
		expect(result).toMatchObject({
			status: "delivered",
			feedbackId: id,
			bundle: {
				status: "pending",
				reason: "unreachable",
				bodyPendingPath: resolveFeedbackPendingPath(root, id),
			},
		});
		if (result.status !== "delivered" || result.bundle?.status !== "pending") return;
		expect(result.bundle.pendingPath).toBeDefined();
		await expect(stat(result.bundle.pendingPath!)).resolves.toBeTruthy();
		await expect(stat(result.bundle.bodyPendingPath!)).resolves.toBeTruthy();
	});

	test("omits the body recovery path when only the pending bundle can be saved", async () => {
		const root = await makeRoot();
		const report = submission();
		const bodyPath = resolveFeedbackPendingPath(root, report.feedbackId);
		await mkdir(bodyPath, { recursive: true });
		const result = await deliverFeedback({
			endpoint: "https://feedback.test/feedback",
			submission: report,
			storageRootDir: root,
			bundle: { endpoint: "https://feedback.test/bundle", data: Buffer.from("archive") },
			fetchImpl: queuedFetch([response(204), response(500)]).fetchImpl,
			retryBackoffsMs: [],
		});

		expect(result).toMatchObject({
			status: "delivered",
			bundle: { status: "pending", reason: "unreachable", pendingPath: expect.any(String) },
		});
		if (result.status !== "delivered" || result.bundle?.status !== "pending") return;
		expect(result.bundle).not.toHaveProperty("bodyPendingPath");
		await expect(stat(result.bundle.pendingPath!)).resolves.toBeTruthy();
	});

	test("uploads the raw gzip bundle with the feedbackId query and collector content type", async () => {
		const root = await makeRoot();
		const archive = await makeCurrentBundle(root);
		const { fetchImpl, calls } = queuedFetch([response(204), response(204)]);
		const result = await deliverFeedback({
			endpoint: "https://feedback.test/api/v1/feedback",
			submission: submission(),
			storageRootDir: root,
			bundle: { endpoint: "https://feedback.test/api/v1/feedback/bundle", data: archive },
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(result).toMatchObject({ status: "delivered", bundle: { status: "uploaded" } });
		expect(calls).toHaveLength(2);
		const bundleRequest = calls[1];
		expect(bundleRequest).toBeDefined();
		const bundleUrl = new URL(bundleRequest!.url);
		expect(bundleUrl.pathname).toBe("/api/v1/feedback/bundle");
		expect(bundleUrl.searchParams.get("feedbackId")).toBe(submission().feedbackId);
		expect(bundleRequest!.init?.headers).toEqual({ "content-type": "application/gzip" });
		expect(Buffer.from(bundleRequest!.init?.body as Uint8Array)).toEqual(archive);
	});

	test("keeps both recovery files when the collector rejects only the archive with HTTP 400", async () => {
		const root = await makeRoot();
		const archive = await makeCurrentBundle(root);
		const result = await deliverFeedback({
			endpoint: "https://feedback.test/feedback",
			submission: submission(),
			storageRootDir: root,
			bundle: { endpoint: "https://feedback.test/bundle", data: archive },
			fetchImpl: queuedFetch([response(204), response(400)]).fetchImpl,
			retryBackoffsMs: [],
		});

		expect(result).toMatchObject({
			status: "delivered",
			bundle: { status: "pending", reason: "rejected", statusCode: 400 },
		});
		const pending = await listPendingFeedback(root);
		expect(pending).toHaveLength(1);
		expect(pending[0]?.body?.submission.feedbackId).toBe(submission().feedbackId);
		expect(pending[0]?.bundlePath).toBeDefined();
	});

	test("reports missing bundle endpoints instead of silently dropping an archive", async () => {
		const root = await makeRoot();
		const result = await deliverFeedback({
			endpoint: "https://feedback.test/feedback",
			submission: submission(),
			storageRootDir: root,
			bundle: { data: Buffer.from("archive") },
			fetchImpl: queuedFetch([response(204)]).fetchImpl,
			retryBackoffsMs: [],
		});
		expect(result).toMatchObject({
			status: "delivered",
			bundle: { status: "pending", reason: "unsupported-endpoint" },
		});
	});

	test("retries body and bundle pending files and removes them after both succeed", async () => {
		const root = await makeRoot();
		const archive = await makeCurrentBundle(root);
		const initial = await deliverFeedback({
			endpoint: "https://feedback.test/feedback",
			submission: submission(),
			storageRootDir: root,
			bundle: { endpoint: "https://feedback.test/bundle", data: archive },
			fetchImpl: queuedFetch([response(204), response(500)]).fetchImpl,
			retryBackoffsMs: [],
		});
		expect(initial.status).toBe("delivered");
		const retried = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl: queuedFetch([response(204), response(204)]).fetchImpl,
			retryBackoffsMs: [],
		});
		expect(retried).toHaveLength(1);
		expect(retried[0]).toMatchObject({ body: { status: "delivered" }, bundle: { status: "uploaded" } });
		expect(await listPendingFeedback(root)).toEqual([]);
	});

	test("reports the retained body path when a pending bundle retry still fails", async () => {
		const root = await makeRoot();
		const report = submission();
		const bodyPendingPath = await writePendingFeedback({ storageRootDir: root, submission: report });
		const bundlePendingPath = await writePendingFeedbackBundle({
			storageRootDir: root,
			feedbackId: report.feedbackId,
			data: await makeCurrentBundle(root),
		});
		const retried = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl: queuedFetch([response(204), response(500)]).fetchImpl,
			retryBackoffsMs: [],
		});

		expect(retried).toMatchObject([
			{
				feedbackId: report.feedbackId,
				body: { status: "delivered" },
				bundle: {
					status: "pending",
					reason: "unreachable",
					pendingPath: bundlePendingPath,
					bodyPendingPath,
				},
			},
		]);
		await expect(stat(bodyPendingPath)).resolves.toBeTruthy();
		await expect(stat(bundlePendingPath)).resolves.toBeTruthy();
	});

	test("stops retrying both routes after the same collector host is unreachable", async () => {
		const root = await makeRoot();
		const bodyId = "11111111-1111-4111-8111-111111111111";
		const bundleId = "22222222-2222-4222-8222-222222222222";
		await writePendingFeedback({ storageRootDir: root, submission: submission(bodyId) });
		await writePendingFeedbackBundle({
			storageRootDir: root,
			feedbackId: bundleId,
			data: await makeCurrentBundle(root),
		});
		const { fetchImpl, calls } = queuedFetch([new Error("offline"), response(204)]);

		const retried = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(calls).toHaveLength(1);
		expect(retried).toMatchObject([
			{ feedbackId: bodyId, body: { status: "pending", reason: "unreachable" } },
			{ feedbackId: bundleId, bundle: { status: "pending", reason: "unreachable" } },
		]);
	});

	test("keeps an unreachable wall scoped to its collector host", async () => {
		const root = await makeRoot();
		const bodyId = "11111111-1111-4111-8111-111111111111";
		const bundleId = "22222222-2222-4222-8222-222222222222";
		await writePendingFeedback({ storageRootDir: root, submission: submission(bodyId) });
		await writePendingFeedbackBundle({
			storageRootDir: root,
			feedbackId: bundleId,
			data: await makeCurrentBundle(root),
		});
		const { fetchImpl, calls } = queuedFetch([new Error("offline"), response(204)]);

		const retried = await retryPendingFeedback({
			endpoint: "https://body-feedback.test/feedback",
			bundleEndpoint: "https://bundle-feedback.test/bundle",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(calls).toHaveLength(2);
		expect(retried).toMatchObject([
			{ feedbackId: bodyId, body: { status: "pending", reason: "unreachable" } },
			{ feedbackId: bundleId, bundle: { status: "uploaded" } },
		]);
	});

	test("stops only body retries after the body route returns 404", async () => {
		const root = await makeRoot();
		const firstBodyId = "11111111-1111-4111-8111-111111111111";
		const secondBodyId = "22222222-2222-4222-8222-222222222222";
		const bundleId = "33333333-3333-4333-8333-333333333333";
		await writePendingFeedback({ storageRootDir: root, submission: submission(firstBodyId) });
		await writePendingFeedback({ storageRootDir: root, submission: submission(secondBodyId) });
		await writePendingFeedbackBundle({
			storageRootDir: root,
			feedbackId: bundleId,
			data: await makeCurrentBundle(root),
		});
		const { fetchImpl, calls } = queuedFetch([response(404), response(204)]);

		const retried = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(calls).toHaveLength(2);
		expect(retried).toMatchObject([
			{ feedbackId: firstBodyId, body: { status: "pending", reason: "unsupported-endpoint", statusCode: 404 } },
			{ feedbackId: secondBodyId, body: { status: "pending", reason: "unsupported-endpoint", statusCode: 404 } },
			{ feedbackId: bundleId, bundle: { status: "uploaded" } },
		]);
	});

	test("stops only bundle retries after the bundle route returns 404", async () => {
		const root = await makeRoot();
		const firstBundleId = "11111111-1111-4111-8111-111111111111";
		const secondBundleId = "22222222-2222-4222-8222-222222222222";
		const bodyId = "33333333-3333-4333-8333-333333333333";
		const archive = await makeCurrentBundle(root);
		await writePendingFeedbackBundle({ storageRootDir: root, feedbackId: firstBundleId, data: archive });
		await writePendingFeedbackBundle({ storageRootDir: root, feedbackId: secondBundleId, data: archive });
		await writePendingFeedback({ storageRootDir: root, submission: submission(bodyId) });
		const { fetchImpl, calls } = queuedFetch([response(404), response(204)]);

		const retried = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(calls).toHaveLength(2);
		expect(retried).toMatchObject([
			{
				feedbackId: firstBundleId,
				bundle: { status: "pending", reason: "unsupported-endpoint", statusCode: 404 },
			},
			{
				feedbackId: secondBundleId,
				bundle: { status: "pending", reason: "unsupported-endpoint", statusCode: 404 },
			},
			{ feedbackId: bodyId, body: { status: "delivered" } },
		]);
	});

	test("ignores a pending body whose feedbackId does not match its filename", async () => {
		const root = await makeRoot();
		const filenameId = "11111111-1111-4111-8111-111111111111";
		const bodyId = "22222222-2222-4222-8222-222222222222";
		const directory = join(root, "feedback");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, `pending-${filenameId}.json`), `${JSON.stringify(submission(bodyId))}\n`);

		expect(await listPendingFeedback(root)).toEqual([]);
	});

	test("converts an exact legacy pending archive before retrying it", async () => {
		const root = await makeRoot();
		const report = submission();
		const legacyNote = "tail only, 30.0 MB on disk";
		await writePendingFeedback({ storageRootDir: root, submission: report });
		await writePendingFeedbackBundle({
			storageRootDir: root,
			feedbackId: report.feedbackId,
			data: await makeLegacyBundle(legacyNote),
		});
		const { fetchImpl, calls } = queuedFetch([response(204), response(204)]);

		const retried = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(retried).toMatchObject([{ body: { status: "delivered" }, bundle: { status: "uploaded" } }]);
		expect(calls).toHaveLength(2);
		const uploaded = Buffer.from(calls[1]!.init?.body as Uint8Array);
		const entries = await readBundleEntries(uploaded);
		expect(entries.map((entry) => entry.name)).toEqual(["events.jsonl", "bundle.json"]);
		expect(entries.find((entry) => entry.name === "events.jsonl")?.content.toString("utf8")).toBe(
			'{"type":"session"}\n',
		);
		const manifest = JSON.parse(entries.find((entry) => entry.name === "bundle.json")!.content.toString("utf8")) as {
			files: Array<{ name: string; bytes: number; note?: string }>;
		};
		expect(manifest.files).toEqual([{ name: "events.jsonl", bytes: 19, note: legacyNote }]);
		expect(await listPendingFeedback(root)).toEqual([]);
	});

	test.each(["unrecognized truncation note", 42] as const)(
		"preserves a legacy archive with unfamiliar note %j",
		async (legacyNote) => {
			const root = await makeRoot();
			const report = submission();
			const archive = await makeLegacyBundle(legacyNote);
			await writePendingFeedback({ storageRootDir: root, submission: report });
			await writePendingFeedbackBundle({
				storageRootDir: root,
				feedbackId: report.feedbackId,
				data: archive,
			});
			const { fetchImpl, calls } = queuedFetch([response(204), response(204)]);

			const retried = await retryPendingFeedback({
				endpoint: "https://feedback.test/feedback",
				bundleEndpoint: "https://feedback.test/bundle",
				storageRootDir: root,
				fetchImpl,
				retryBackoffsMs: [],
			});

			expect(calls).toHaveLength(1);
			expect(retried).toMatchObject([
				{ body: { status: "delivered" }, bundle: { status: "pending", reason: "rejected" } },
			]);
			const pending = await listPendingFeedback(root);
			expect(pending[0]?.body).toBeDefined();
			expect(await readFile(pending[0]!.bundlePath!)).toEqual(archive);
		},
	);

	test("passes a current pending archive through unchanged", async () => {
		const root = await makeRoot();
		const report = submission();
		const archive = await makeCurrentBundle(root);
		await writePendingFeedback({ storageRootDir: root, submission: report });
		await writePendingFeedbackBundle({ storageRootDir: root, feedbackId: report.feedbackId, data: archive });
		const { fetchImpl, calls } = queuedFetch([response(204), response(204)]);

		await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(Buffer.from(calls[1]!.init?.body as Uint8Array)).toEqual(archive);
		expect(await listPendingFeedback(root)).toEqual([]);
	});

	test("preserves body and archive when pending archive conversion fails", async () => {
		const root = await makeRoot();
		const report = submission();
		await writePendingFeedback({ storageRootDir: root, submission: report });
		await writePendingFeedbackBundle({
			storageRootDir: root,
			feedbackId: report.feedbackId,
			data: Buffer.from("not a gzip tar"),
		});
		const { fetchImpl, calls } = queuedFetch([response(204)]);

		const retried = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(calls).toHaveLength(1);
		expect(retried).toMatchObject([
			{ body: { status: "delivered" }, bundle: { status: "pending", reason: "rejected" } },
		]);
		const pending = await listPendingFeedback(root);
		expect(pending[0]?.body).toBeDefined();
		expect(pending[0]?.bundlePath).toBeDefined();
		expect(await readFile(pending[0]!.bundlePath!)).toEqual(Buffer.from("not a gzip tar"));
	});

	test("maps bundle HTTP 409 to body-missing", async () => {
		const root = await makeRoot();
		const result = await deliverFeedback({
			endpoint: "https://feedback.test/feedback",
			submission: submission(),
			storageRootDir: root,
			bundle: { endpoint: "https://feedback.test/bundle", data: Buffer.from("archive") },
			fetchImpl: queuedFetch([response(204), response(409)]).fetchImpl,
			retryBackoffsMs: [],
		});
		expect(result).toMatchObject({ status: "delivered", bundle: { status: "pending", reason: "body-missing" } });
	});
});

describe("feedback diagnostics and bundles", () => {
	test("reads the newest bounded input trace", async () => {
		const root = await makeRoot();
		await mkdir(join(root, "diagnostics"), { recursive: true });
		const firstTrace = join(root, "diagnostics", "input-trace-1.jsonl");
		const newestTrace = join(root, "diagnostics", "input-trace-2.jsonl");
		await writeFile(firstTrace, "first\n");
		await writeFile(newestTrace, `\u001b[31m${"x".repeat(600)}\u001b[0m\n`);
		const older = new Date("2026-08-31T00:00:00.000Z");
		const newer = new Date("2026-08-31T00:01:00.000Z");
		await utimes(firstTrace, older, older);
		await utimes(newestTrace, newer, newer);
		const result = await readFeedbackDiagnostics({ storageRootDir: root });
		expect(result?.diagnostics.source).toBe("input_trace");
		expect(result?.diagnostics.lines[0]).toHaveLength(FEEDBACK_DIAGNOSTICS_MAX_LINE_CHARS);
		expect(result?.diagnostics.truncated).toBe(true);
	});

	test.skipIf(process.platform === "win32")("does not read diagnostic files through symbolic links", async () => {
		const root = await makeRoot();
		const outside = await mkdtemp(join(tmpdir(), "step-feedback-diagnostics-outside-"));
		roots.push(outside);
		const at = new Date("2026-08-31T00:00:00.000Z");
		const externalTrace = join(outside, "external-trace.jsonl");
		const externalLog = join(outside, "external-log.log");
		await writeFile(externalTrace, "Error: external trace\n");
		await writeFile(externalLog, "Error: external log\n");
		await mkdir(join(root, "diagnostics"), { recursive: true });
		await mkdir(join(root, "logs"), { recursive: true });
		await symlink(externalTrace, join(root, "diagnostics", "input-trace-external.jsonl"));
		await symlink(externalLog, resolveStderrDevLogPath(root, at));

		expect(await readFeedbackDiagnostics({ storageRootDir: root, at })).toBeUndefined();
	});

	test("creates a collector-compatible archive whose bundle manifest matches its payload files", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260831_session-1.jsonl");
		await writeFile(sessionFile, '{"type":"session"}\n');
		const result = await buildFeedbackSessionBundle({
			storageRootDir: root,
			sessionFile,
			at: new Date("2026-08-31T00:00:00.000Z"),
		});
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.bundle.data.byteLength).toBeLessThan(FEEDBACK_BUNDLE_MAX_BYTES);
		const entries = await readBundleEntries(result.bundle.data);
		expect(entries.map((entry) => entry.name)).toEqual(["events.jsonl", "bundle.json"]);
		const events = entries.find((entry) => entry.name === "events.jsonl");
		const manifestEntry = entries.find((entry) => entry.name === "bundle.json");
		expect(events?.content.toString("utf8")).toBe('{"type":"session"}\n');
		const manifest = JSON.parse(manifestEntry!.content.toString("utf8")) as Record<string, unknown>;
		expect(manifest).toMatchObject({
			sessionId: "session-1",
			createdAt: "2026-08-31T00:00:00.000Z",
			files: [{ name: "events.jsonl", bytes: events!.content.byteLength }],
		});
		expect(result.bundle.files).toEqual(manifest.files);
		expect(result.bundle.sessionId).toBe("session-1");
	});

	test("uses the first nonempty JSONL session header ID for an explicitly selected path", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260831_filename-session.jsonl");
		await writeFile(sessionFile, '\n\n{"type":"session","id":"header-session"}\n');

		const result = await buildFeedbackSessionBundle({ storageRootDir: root, sessionId: sessionFile });

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.bundle.sessionId).toBe("header-session");
		const entries = await readBundleEntries(result.bundle.data);
		const manifest = JSON.parse(entries.find((entry) => entry.name === "bundle.json")!.content.toString("utf8")) as {
			sessionId: string;
		};
		expect(manifest.sessionId).toBe("header-session");
	});

	test("resolves relative JSONL path selectors against the current working directory", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "relative-session.jsonl");
		await writeFile(sessionFile, '{"type":"session","id":"relative-header-session"}\n');
		const sessionPath = relative(process.cwd(), sessionFile);

		const result = await buildFeedbackSessionBundle({ storageRootDir: root, sessionId: sessionPath });

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.bundle.sessionId).toBe("relative-header-session");
	});

	test("resolves a bare relative JSONL filename against the current working directory", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "bare-session.jsonl");
		await writeFile(sessionFile, '{"type":"session","id":"bare-header-session"}\n');
		const previousCwd = process.cwd();

		try {
			process.chdir(root);
			const result = await buildFeedbackSessionBundle({ storageRootDir: root, sessionId: "bare-session.jsonl" });
			expect(result.status).toBe("ready");
			if (result.status !== "ready") return;
			expect(result.bundle.sessionId).toBe("bare-header-session");
		} finally {
			process.chdir(previousCwd);
		}
	});

	test.each([
		["blank ID", '{"type":"session","id":"   "}\n'],
		["unsafe ID", '{"type":"session","id":"../../private"}\n'],
		["wrong entry type", '{"type":"message","id":"message-id"}\n{"type":"session","id":"late-session"}\n'],
	] as const)("falls back to the filename for a session header with %s", async (_case, header) => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260831_fallback-session.jsonl");
		await writeFile(sessionFile, header);

		const result = await buildFeedbackSessionBundle({ storageRootDir: root, sessionFile });

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.bundle.sessionId).toBe("fallback-session");
	});

	test("skips an explicitly selected session containing malformed JSONL", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260831_fallback-session.jsonl");
		await writeFile(sessionFile, 'not-json\n{"type":"session","id":"header-session"}\n');

		await expect(buildFeedbackSessionBundle({ storageRootDir: root, sessionFile })).resolves.toEqual({
			status: "skipped",
			reason: "unsafe",
		});
	});

	test("falls back to the filename when the session header exceeds the bounded read", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260831_fallback-session.jsonl");
		const oversizedHeader = `${JSON.stringify({
			type: "session",
			padding: "x".repeat(1024 * 1024),
			id: "unbounded-header-session",
		})}\n`;
		await writeFile(sessionFile, oversizedHeader);

		const result = await buildFeedbackSessionBundle({ storageRootDir: root, sessionFile });

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.bundle.sessionId).toBe("fallback-session");
	});

	test("rejects an ambiguous explicit session ID instead of choosing the first matching file", async () => {
		const root = await makeRoot();
		for (const project of ["project-a", "project-b"]) {
			const directory = join(root, project);
			await mkdir(directory, { recursive: true });
			await writeFile(
				join(directory, "20260831_duplicate-session.jsonl"),
				'{"type":"session","id":"duplicate-session"}\n',
			);
		}

		await expect(
			buildFeedbackSessionBundle({
				storageRootDir: root,
				sessionDir: root,
				sessionId: "duplicate-session",
			}),
		).resolves.toEqual({ status: "skipped", reason: "no-session" });
	});

	test("matches an explicit session ID against the header instead of the filename", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "unrelated-file-name.jsonl");
		await writeFile(sessionFile, '{"type":"session","id":"requested-session"}\n');

		const result = await buildFeedbackSessionBundle({
			storageRootDir: root,
			sessionDir: root,
			sessionId: "requested-session",
		});

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.bundle.sessionId).toBe("requested-session");
	});

	test("ignores a newer non-session JSONL file while guessing the latest session", async () => {
		const root = await makeRoot();
		const sessionDir = join(root, "sessions");
		await mkdir(sessionDir, { recursive: true });
		const now = new Date("2026-08-31T00:10:00.000Z");
		const validSessionFile = join(sessionDir, "valid.jsonl");
		const unrelatedFile = join(sessionDir, "unrelated.jsonl");
		await writeFile(validSessionFile, '{"type":"session","id":"valid-session"}\n');
		await writeFile(unrelatedFile, '{"type":"message","id":"not-a-session"}\n');
		const validMtime = new Date(now.getTime() - 60_000);
		await utimes(validSessionFile, validMtime, validMtime);
		await utimes(unrelatedFile, now, now);

		const result = await buildFeedbackSessionBundle({ storageRootDir: root, sessionDir, now });

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.bundle.sessionId).toBe("valid-session");
		expect(result.bundle.lastActivityAt).toEqual(validMtime);
	});

	test("adds bounded error context from the daily dev log and exposes it in the consent preview", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260831_session-1.jsonl");
		await writeFile(sessionFile, '{"type":"session"}\n');
		const secret = "ghp_ABCDEFGHIJKLMNOPQRST0123456789";
		const at = new Date();
		await mkdir(join(root, "logs"), { recursive: true });
		await writeFile(
			resolveStderrDevLogPath(root, at),
			`before\n\u001b[31mError: request failed token=${secret}\u001b[0m\nError: controls a\bB \u009b31mred\u001b[0m\nafter\nError: unterminated link \u001b]8;;https://evil.test`,
		);
		const result = await buildFeedbackSessionBundle({ storageRootDir: root, sessionFile, at });

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		const entries = await readBundleEntries(result.bundle.data);
		expect(entries.map((entry) => entry.name)).toEqual(["events.jsonl", "dev.log", "bundle.json"]);
		const devLog = entries.find((entry) => entry.name === "dev.log")?.content.toString("utf8") ?? "";
		expect(devLog).toContain("Error: request failed");
		expect(devLog).toContain("Error: controls aB red");
		expect(devLog).toContain("Error: unterminated link ");
		expect(devLog).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
		expect(devLog).not.toContain("https://evil.test");
		expect(devLog).not.toContain(secret);
		expect(devLog).toContain("<redacted:secret>");
		const preview = describeFeedbackBundle(result.bundle);
		expect(preview).toContain("events.jsonl (");
		expect(preview).toContain("dev.log (");
		expect(preview).toContain("It contains the conversation itself:");
	});

	test("keeps diagnostics available while omitting an ordinary stderr log from the archive", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260831_session-1.jsonl");
		await writeFile(sessionFile, '{"type":"session"}\n');
		await appendStderrDevLog("ordinary warning without a matching keyword\n", root);
		const at = new Date();
		const diagnostics = await readFeedbackDiagnostics({ storageRootDir: root, at });
		const result = await buildFeedbackSessionBundle({ storageRootDir: root, sessionFile, at });

		expect(diagnostics?.diagnostics.source).toBe("stderr_dev_log");
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		const entries = await readBundleEntries(result.bundle.data);
		expect(entries.map((entry) => entry.name)).toEqual(["events.jsonl", "bundle.json"]);
		expect(describeFeedbackBundle(result.bundle)).not.toContain("dev.log (");
	});

	test("preserves the first diagnostic line when the tail starts after a newline", async () => {
		const root = await makeRoot();
		const windowBytes = 64 * 1024;
		const prefix = "p\n".repeat(windowBytes / 2);
		const firstLine = "Error: boundary\n";
		const suffix = firstLine + "x".repeat(windowBytes - Buffer.byteLength(firstLine));
		expect(Buffer.byteLength(prefix + suffix)).toBe(windowBytes * 2);
		await mkdir(join(root, "diagnostics"), { recursive: true });
		await writeFile(join(root, "diagnostics", "input-trace-boundary.jsonl"), prefix + suffix);

		const result = await readFeedbackDiagnostics({ storageRootDir: root });

		expect(result?.diagnostics.lines[0]).toBe("Error: boundary");
		expect(result?.diagnostics.truncated).toBe(true);
	});

	test("preserves the first dev-log line when the tail starts after a newline", async () => {
		const root = await makeRoot();
		const at = new Date("2026-08-31T00:00:00.000Z");
		const sessionFile = join(root, "20260831_boundary-session.jsonl");
		await writeFile(sessionFile, '{"type":"session"}\n');

		const windowBytes = 5 * 1024 * 1024;
		const prefix = "p\n".repeat(windowBytes / 2);
		const firstLine = "Error: boundary\n";
		const suffix = firstLine + "x\n".repeat((windowBytes - Buffer.byteLength(firstLine)) / 2);
		expect(Buffer.byteLength(prefix + suffix)).toBe(windowBytes * 2);
		await mkdir(join(root, "logs"), { recursive: true });
		await writeFile(resolveStderrDevLogPath(root, at), prefix + suffix);

		const result = await buildFeedbackSessionBundle({ storageRootDir: root, sessionFile, at });

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		const entries = await readBundleEntries(result.bundle.data);
		const devLog = entries.find((entry) => entry.name === "dev.log");
		expect(devLog?.content.toString("utf8")).toContain("Error: boundary");
		const manifest = JSON.parse(entries.find((entry) => entry.name === "bundle.json")!.content.toString("utf8")) as {
			files: Array<{ name: string; bytes: number }>;
		};
		expect(manifest.files).toContainEqual(
			expect.objectContaining({ name: "dev.log", bytes: devLog!.content.byteLength }),
		);
	});

	test("mirrors stderr unchanged while redacting the persisted daily log", async () => {
		const root = await makeRoot();
		const original = captureOutput();
		const mirror = createStderrMirrorWrite({
			baseWrite: original.stream.write.bind(original.stream) as NodeJS.WriteStream["write"],
			getStorageRootDir: () => root,
		});
		const secret = "ghp_ABCDEFGHIJKLMNOPQRST0123456789";
		const text = `Error: auth failed for ${secret}\n`;

		mirror(text);
		await mirror.flush();

		expect(original.text()).toBe(text);
		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain("Error: auth failed");
		expect(persisted).toContain("<redacted:secret>");
		expect(persisted).not.toContain(secret);
	});

	test("skips a stale guessed session but keeps an explicit one", async () => {
		const root = await makeRoot();
		const sessionDir = join(root, "agent", "sessions");
		await mkdir(sessionDir, { recursive: true });
		const sessionFile = join(sessionDir, "20260101_old-session.jsonl");
		await writeFile(sessionFile, '{"type":"session","id":"old-session"}\n');
		const old = new Date("2026-01-01T00:00:00.000Z");
		await utimes(sessionFile, old, old);
		const now = new Date("2026-08-31T00:00:00.000Z");
		// Guessed selection (no --session, no live sessionId) outside the recency window: no bundle.
		const guessed = await buildFeedbackSessionBundle({ storageRootDir: root, sessionDir, now });
		expect(guessed).toEqual({ status: "skipped", reason: "stale" });
		// An explicit session file skips the window entirely.
		const explicit = await buildFeedbackSessionBundle({ storageRootDir: root, sessionFile, now });
		expect(explicit.status).toBe("ready");
	});

	test("redacts credentials in the session bundle", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260831_session-1.jsonl");
		await writeFile(sessionFile, '{"type":"message","text":"token=ghp_ABCDEFGHIJKLMNOPQRST0123456789"}\n');
		const result = await buildFeedbackSessionBundle({ storageRootDir: root, sessionFile });
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		const tar = (await gunzip(result.bundle.data)).toString("utf8");
		expect(tar).not.toContain("ghp_ABCDEFGHIJKLMNOPQRST0123456789");
		expect(tar).toContain("<redacted:secret>");
	});

	test("re-limits events at a complete line after secret redaction expands them", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260831_session-1.jsonl");
		const sourceLine = '{"token":"a"}\n';
		const sourceBytes = 12 * 1024 * 1024;
		await writeFile(sessionFile, sourceLine.repeat(Math.ceil(sourceBytes / Buffer.byteLength(sourceLine))));

		const result = await buildFeedbackSessionBundle({ storageRootDir: root, sessionFile });
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		const entries = await readBundleEntries(result.bundle.data);
		const events = entries.find((entry) => entry.name === "events.jsonl");
		const manifestEntry = entries.find((entry) => entry.name === "bundle.json");
		expect(events).toBeDefined();
		expect(events!.content.byteLength).toBeLessThanOrEqual(24 * 1024 * 1024);
		expect(events!.content.subarray(0, 30).toString("utf8")).toBe('{"token":"<redacted:secret>"}\n');
		const manifest = JSON.parse(manifestEntry!.content.toString("utf8")) as {
			files: Array<{ name: string; bytes: number; note?: string }>;
		};
		expect(manifest.files[0]).toMatchObject({
			name: "events.jsonl",
			bytes: events!.content.byteLength,
			note: expect.stringContaining("re-limited after redaction"),
		});
		expect(result.bundle.files).toEqual(manifest.files);
	});

	test("redacts tail echoes using credentials discovered before both session limits", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260831_session-1.jsonl");
		const secret = "prefix-only-secret-12345678";
		const randomFiller = randomBytes(19 * 1024 * 1024)
			.toString("base64")
			.replace(/(.{1,4096})/gu, '{"filler":"$1"}\n');
		await writeFile(
			sessionFile,
			`${JSON.stringify({ API_KEY: secret })}\n${randomFiller}\n${JSON.stringify({ echo: secret })}\n`,
		);

		const result = await buildFeedbackSessionBundle({ storageRootDir: root, sessionFile });

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		const entries = await readBundleEntries(result.bundle.data);
		const events = entries.find((entry) => entry.name === "events.jsonl");
		expect(events).toBeDefined();
		expect(events!.content.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
		expect(events!.content.toString("utf8")).not.toContain(secret);
		expect(events!.content.toString("utf8")).toContain("<redacted:secret>");
		expect(result.bundle.files[0]?.note).toContain("compressed-size fallback limited to 2.0 MB");
	});

	test("skips a large session whose tail begins inside a multiline private key", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260831_session-1.jsonl");
		const privateKeyBody = "private-base64-material\n".repeat(
			Math.ceil((25 * 1024 * 1024) / Buffer.byteLength("private-base64-material\n")),
		);
		await writeFile(
			sessionFile,
			`-----BEGIN PGP PRIVATE KEY BLOCK-----\n${privateKeyBody}-----END PGP PRIVATE KEY BLOCK-----\n`,
		);

		await expect(buildFeedbackSessionBundle({ storageRootDir: root, sessionFile })).resolves.toEqual({
			status: "skipped",
			reason: "unsafe",
		});
	});

	test("skips scalar JSON lines that could split a secret before the bounded tail", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260831_session-1.jsonl");
		const fillerLine = '{"type":"message","text":"ordinary filler"}\n';
		const filler = fillerLine.repeat(Math.ceil((25 * 1024 * 1024) / Buffer.byteLength(fillerLine)));
		await writeFile(
			sessionFile,
			`"api_key"\n":"\n"split-scalar-secret-12345678"\n${filler}{"echo":"split-scalar-secret-12345678"}\n`,
		);

		await expect(buildFeedbackSessionBundle({ storageRootDir: root, sessionFile })).resolves.toEqual({
			status: "skipped",
			reason: "unsafe",
		});
	});
});

describe("feedback CLI parser", () => {
	test("distinguishes missing and invalid category values", () => {
		expect(parseFeedbackArgs(["--category"]).error).toBe("--category requires a value");
		expect(parseFeedbackArgs(["--category", "typo"]).error).toContain("unknown category");
		expect(parseFeedbackArgs(["--category", "bad-result", "--message", "hello"])).toMatchObject({
			category: "bad_result",
			message: "hello",
		});
	});

	test("uses the exact support-ID wording shared with the TUI", () => {
		expect(formatFeedbackSubmittedMessage("feedback-id")).toBe(
			"Submitted. Feedback ID: feedback-id — include this ID when contacting support.",
		);
	});

	test("reports a delivered body and a pending session archive separately", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260831_session-1.jsonl");
		await writeFile(sessionFile, '{"type":"session"}\n');
		const stdout = captureOutput();
		const stderr = captureOutput();
		const exitCode = await runFeedbackCommand(["It failed", "--session-bundle"], {
			storageRootDir: root,
			sessionFile,
			sessionId: "session-1",
			interactive: false,
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: {
				STEP_HARNESS_FEEDBACK_ENDPOINT: "https://feedback.test/feedback",
				STEP_HARNESS_FEEDBACK_BUNDLE_ENDPOINT: "https://feedback.test/bundle",
			},
			fetchImpl: queuedFetch([response(204), response(413)]).fetchImpl,
		});

		expect(exitCode).toBe(0);
		expect(stdout.text()).toMatch(
			/^Submitted\. Feedback ID: [0-9a-f-]+ — include this ID when contacting support\.\n$/u,
		);
		expect(stderr.text()).toContain("The session archive was not uploaded:");
		expect(stderr.text()).toContain("HTTP 413");
		expect(stderr.text()).toContain(join(root, "feedback", "pending-"));
		expect(stderr.text()).toContain("Retrying the same archive cannot work");
		expect(stderr.text()).not.toContain("step feedback --retry");
	});
});
