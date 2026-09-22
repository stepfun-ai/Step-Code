import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Simulate a filesystem whose stat-based revision does not change for a fast,
// same-sized rewrite. The AuthStorage reload path must use content instead.
vi.mock("../src/utils/paths.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/paths.ts")>();
	return { ...actual, getFileRevision: () => "coarse-revision" };
});

import { AuthStorage } from "../src/core/auth-storage.ts";

describe("AuthStorage content revisions", () => {
	const tempDir = join(tmpdir(), `pi-test-auth-storage-revision-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const authJsonPath = join(tempDir, "auth.json");

	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		vi.restoreAllMocks();
	});

	test("reloads a same-sized rewrite when metadata revision is unchanged", async () => {
		writeFileSync(authJsonPath, JSON.stringify({ anthropic: { type: "api_key", key: "old" } }));
		const storage = AuthStorage.create(authJsonPath);

		// "old" and "new" have the same length, which is the failure mode on
		// filesystems that expose coarse or cached timestamp metadata.
		writeFileSync(authJsonPath, JSON.stringify({ anthropic: { type: "api_key", key: "new" } }));

		await expect(storage.read("anthropic")).resolves.toEqual({ type: "api_key", key: "new" });
	});
});
