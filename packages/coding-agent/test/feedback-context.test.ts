import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFeedbackUsername, resolveFeedbackContext } from "../src/step/feedback/context.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "step-feedback-context-"));
	roots.push(root);
	return root;
}

describe("feedback context identity boundaries", () => {
	it("reads a bounded launcher username", () => {
		expect(readFeedbackUsername({ STEPCODE_USER: "  account@example.test\n" })).toBe("account@example.test");
		expect(readFeedbackUsername({ STEPCODE_USER: "not a username" })).toBeUndefined();
	});

	it("keeps valid host and session identities after trimming", async () => {
		const context = await resolveFeedbackContext({
			storageRootDir: await makeRoot(),
			env: {},
			uid: "  account_42@example.test  ",
			sessionId: "  session-42_v2.test  ",
		});

		expect(context.uid).toBe("account_42@example.test");
		expect(context.sessionId).toBe("session-42_v2.test");
	});

	it.each([
		["overlong", "u".repeat(65)],
		["control", "user\u0000id"],
		["whitespace", "user id"],
		["markup", "<script>"],
		["path", "../account"],
	])("omits an invalid uid (%s)", async (_label, uid) => {
		const context = await resolveFeedbackContext({
			storageRootDir: await makeRoot(),
			env: {},
			uid,
		});

		expect(context.uid).toBeUndefined();
	});

	it.each([
		["empty", ""],
		["control", "session\u0000id"],
		["line separator", "session\u2028id"],
		["overlong", "s".repeat(129)],
	])("omits an invalid wire session id (%s)", async (_label, sessionId) => {
		const context = await resolveFeedbackContext({
			storageRootDir: await makeRoot(),
			env: {},
			sessionId,
		});

		expect(context.sessionId).toBeUndefined();
	});

	it("preserves legacy wire session ids that are not local path names", async () => {
		const context = await resolveFeedbackContext({
			storageRootDir: await makeRoot(),
			env: {},
			sessionId: "team/agent one",
		});

		expect(context.sessionId).toBe("team/agent one");
	});

	it("does not throw or emit non-string identities from an embedding host", async () => {
		const context = await resolveFeedbackContext({
			storageRootDir: await makeRoot(),
			env: {},
			uid: 42 as unknown as string,
			sessionId: { id: "session-1" } as unknown as string,
			username: 42 as unknown as string,
		});

		expect(context.uid).toBeUndefined();
		expect(context.sessionId).toBeUndefined();
		expect(context.username).toBeUndefined();
	});
});
