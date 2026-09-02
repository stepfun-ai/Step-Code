import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildFeedbackSessionBundle } from "../src/step/feedback/bundle.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "step-feedback-session-root-test-"));
	roots.push(root);
	return root;
}

async function writeSession(sessionDir: string, sessionId: string, mtime: Date): Promise<void> {
	await mkdir(sessionDir, { recursive: true });
	const sessionFile = join(sessionDir, `20260901_${sessionId}.jsonl`);
	await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
	await utimes(sessionFile, mtime, mtime);
}

describe("feedback session root", () => {
	test("guesses the newest session from the configured agent directory, independently of feedback storage", async () => {
		const root = await makeRoot();
		const agentDir = join(root, "custom-agent");
		const storageRootDir = join(root, "independent-feedback-storage");
		const now = new Date("2026-09-01T08:00:00.000Z");
		await writeSession(join(agentDir, "sessions", "project"), "agent-session", now);

		const result = await buildFeedbackSessionBundle({
			storageRootDir,
			env: { STEP_CODING_AGENT_DIR: agentDir },
			now,
		});

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.bundle.sessionId).toBe("agent-session");
	});

	test("prefers an explicit session directory over the environment session root", async () => {
		const root = await makeRoot();
		const envSessionDir = join(root, "environment-sessions");
		const explicitSessionDir = join(root, "explicit-sessions");
		const now = new Date("2026-09-01T08:00:00.000Z");
		await writeSession(envSessionDir, "environment-session", now);
		await writeSession(explicitSessionDir, "explicit-session", new Date(now.getTime() - 60_000));

		const result = await buildFeedbackSessionBundle({
			storageRootDir: join(root, "feedback-storage"),
			sessionDir: explicitSessionDir,
			env: { STEP_CODING_AGENT_SESSION_DIR: envSessionDir },
			now,
		});

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.bundle.sessionId).toBe("explicit-session");
	});

	test("prefers the explicit file header over a supplied live session id", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260901_filename-session.jsonl");
		await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "header-session" })}\n`);

		const result = await buildFeedbackSessionBundle({
			storageRootDir: join(root, "feedback-storage"),
			sessionFile,
			sessionId: "live-session",
		});

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.bundle.sessionId).toBe("header-session");
	});

	test("uses a supplied live session id when the explicit file header is invalid", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "20260901_filename-session.jsonl");
		await writeFile(sessionFile, `${JSON.stringify({ type: "message", id: "wrong-record" })}\n`);

		const result = await buildFeedbackSessionBundle({
			storageRootDir: join(root, "feedback-storage"),
			sessionFile,
			sessionId: "live-session",
		});

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.bundle.sessionId).toBe("live-session");
	});

	test.skipIf(process.platform === "win32")(
		"does not archive an explicitly selected symbolic-link session",
		async () => {
			const root = await makeRoot();
			const outside = await mkdtemp(join(tmpdir(), "step-feedback-session-outside-"));
			roots.push(outside);
			const externalSession = join(outside, "external.jsonl");
			await writeFile(externalSession, '{"type":"session","id":"external-session"}\n');
			const linkedSession = join(root, "linked-session.jsonl");
			await symlink(externalSession, linkedSession);

			await expect(
				buildFeedbackSessionBundle({
					storageRootDir: root,
					sessionFile: linkedSession,
				}),
			).resolves.toEqual({ status: "skipped", reason: "no-session" });
		},
	);
});
