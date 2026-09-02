import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { retryPendingFeedback } from "../src/step/feedback/delivery.ts";
import {
	resolveFeedbackDirectory,
	resolveFeedbackPendingPath,
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
});
