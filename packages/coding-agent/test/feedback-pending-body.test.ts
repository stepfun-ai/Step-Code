import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { retryPendingFeedback } from "../src/step/feedback/delivery.ts";
import {
	resolveFeedbackDirectory,
	resolveFeedbackPendingPath,
	writePendingFeedback,
	writePendingFeedbackBundle,
} from "../src/step/feedback/pending-store.ts";
import type { FeedbackSubmission } from "../src/step/feedback/types.ts";

const roots: string[] = [];
const TIMESTAMP = "2026-09-01T00:00:00.000Z";

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "step-feedback-pending-body-test-"));
	roots.push(root);
	await mkdir(resolveFeedbackDirectory(root), { recursive: true });
	return root;
}

function makeSubmission(feedbackId: string): FeedbackSubmission {
	return {
		feedbackId,
		category: "bug",
		comment: "It failed",
		at: TIMESTAMP,
		context: { channel: "test", version: "0.0.0", platform: "darwin" },
	};
}

describe("pending feedback body validation", () => {
	test("posts only a valid body and leaves every invalid body unchanged", async () => {
		const root = await makeRoot();
		const invalidBodies = [
			{ category: "unknown" },
			{ category: null },
			{ at: undefined },
			{ at: 42 },
			{ context: undefined },
			{ context: null },
			{ context: [] },
		] as const;
		const invalidFiles: Array<{ path: string; content: string }> = [];
		for (const [index, override] of invalidBodies.entries()) {
			const feedbackId = `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
			const submission: Record<string, unknown> = { ...makeSubmission(feedbackId), ...override };
			if ("at" in override && override.at === undefined) delete submission.at;
			if ("context" in override && override.context === undefined) delete submission.context;
			const path = resolveFeedbackPendingPath(root, feedbackId);
			const content = `${JSON.stringify(submission, null, 2)}\n`;
			await writeFile(path, content);
			invalidFiles.push({ path, content });
		}

		const mismatchedFileId = "10000000-0000-4000-8000-000000000008";
		const mismatchedPath = resolveFeedbackPendingPath(root, mismatchedFileId);
		const mismatchedContent = `${JSON.stringify(makeSubmission("10000000-0000-4000-8000-000000000009"), null, 2)}\n`;
		await writeFile(mismatchedPath, mismatchedContent);
		invalidFiles.push({ path: mismatchedPath, content: mismatchedContent });

		const validFeedbackId = "10000000-0000-4000-8000-000000000010";
		const validPath = resolveFeedbackPendingPath(root, validFeedbackId);
		await writeFile(validPath, `${JSON.stringify(makeSubmission(validFeedbackId), null, 2)}\n`);
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

		const outcomes = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
			feedbackId: validFeedbackId,
		});
		expect(outcomes).toEqual([
			{ feedbackId: validFeedbackId, body: { status: "delivered", feedbackId: validFeedbackId } },
		]);
		await expect(stat(validPath)).rejects.toMatchObject({ code: "ENOENT" });
		for (const invalidFile of invalidFiles) {
			await expect(readFile(invalidFile.path, "utf8")).resolves.toBe(invalidFile.content);
		}
	});

	test("does not upload a bundle when its paired body is malformed", async () => {
		const root = await makeRoot();
		const feedbackId = "70000000-0000-7000-8000-000000000001";
		const bodyPath = resolveFeedbackPendingPath(root, feedbackId);
		const bundleBytes = Buffer.from("bundle-bytes");
		const body = {
			...makeSubmission(feedbackId),
			comment: "sk-abcdefghijklmnop",
			at: "not-a-date",
		};
		const bodyBytes = `${JSON.stringify(body, null, 2)}\n`;
		await writeFile(bodyPath, bodyBytes);
		const bundlePath = await writePendingFeedbackBundle({ storageRootDir: root, feedbackId, data: bundleBytes });

		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
		const outcomes = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(outcomes).toEqual([
			{
				feedbackId,
				body: { status: "pending", feedbackId, reason: "rejected", pendingPath: bodyPath },
				bundle: {
					status: "pending",
					reason: "body-pending",
					pendingPath: bundlePath,
					bodyPendingPath: bodyPath,
				},
			},
		]);
		expect(await readFile(bodyPath, "utf8")).toBe(bodyBytes);
		expect(await readFile(bundlePath)).toEqual(bundleBytes);
	});

	test("accepts UUID v7 pending ids", async () => {
		const root = await makeRoot();
		const feedbackId = "018f2f5e-7b2c-7abc-8def-123456789abc";
		const pendingPath = resolveFeedbackPendingPath(root, feedbackId);
		await writeFile(pendingPath, `${JSON.stringify(makeSubmission(feedbackId))}\n`);
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

		const outcomes = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(outcomes).toEqual([{ feedbackId, body: { status: "delivered", feedbackId } }]);
		expect(fetchImpl).toHaveBeenCalledOnce();
		await expect(stat(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test.skipIf(process.platform === "win32")("does not read or overwrite a symbolic-link pending body", async () => {
		const root = await makeRoot();
		const outside = await mkdtemp(join(tmpdir(), "step-feedback-pending-body-outside-"));
		roots.push(outside);
		const feedbackId = "80000000-0000-4000-8000-000000000001";
		const externalPath = join(outside, "external-body.json");
		const externalContent = `${JSON.stringify(makeSubmission(feedbackId))}\n`;
		await writeFile(externalPath, externalContent);
		const pendingPath = resolveFeedbackPendingPath(root, feedbackId);
		await symlink(externalPath, pendingPath);
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

		await expect(
			retryPendingFeedback({
				endpoint: "https://feedback.test/feedback",
				storageRootDir: root,
				fetchImpl,
				retryBackoffsMs: [],
			}),
		).resolves.toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
		await expect(readFile(externalPath, "utf8")).resolves.toBe(externalContent);
		await expect(
			writePendingFeedback({ storageRootDir: root, submission: makeSubmission(feedbackId) }),
		).rejects.toThrow("symbolic link");
		await expect(readFile(externalPath, "utf8")).resolves.toBe(externalContent);
	});

	test.skipIf(process.platform === "win32")("does not read or overwrite a symbolic-link pending archive", async () => {
		const root = await makeRoot();
		const outside = await mkdtemp(join(tmpdir(), "step-feedback-pending-archive-outside-"));
		roots.push(outside);
		const feedbackId = "80000000-0000-4000-8000-000000000002";
		const externalPath = join(outside, "external-archive.tar.gz");
		const externalContent = Buffer.from("external archive bytes");
		await writeFile(externalPath, externalContent);
		const pendingPath = join(resolveFeedbackDirectory(root), `pending-${feedbackId}.tar.gz`);
		await symlink(externalPath, pendingPath);
		const bodyPath = await writePendingFeedback({ storageRootDir: root, submission: makeSubmission(feedbackId) });
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

		const outcomes = await retryPendingFeedback({
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			storageRootDir: root,
			fetchImpl,
			retryBackoffsMs: [],
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(outcomes).toMatchObject([
			{
				feedbackId,
				body: { status: "delivered" },
				bundle: { status: "pending", reason: "unreachable", pendingPath },
			},
		]);
		await expect(stat(bodyPath)).resolves.toBeTruthy();
		await expect(readFile(externalPath)).resolves.toEqual(externalContent);
		await expect(
			writePendingFeedbackBundle({ storageRootDir: root, feedbackId, data: Buffer.from("replacement") }),
		).rejects.toThrow("symbolic link");
		await expect(readFile(externalPath)).resolves.toEqual(externalContent);
	});
});
