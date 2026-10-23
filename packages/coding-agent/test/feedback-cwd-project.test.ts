import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveFeedbackSession } from "../src/step/feedback/bundle.ts";
import { prepareFeedbackEvidence } from "../src/step/feedback/evidence.ts";

/**
 * The project a report is filed from decides which conversation a guessed
 * session may attach. With `-C/--cwd` the session's project is not the
 * process's working directory, so the caller has to say which one it means.
 */

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
	root: string;
	sessions: string;
	project: string;
	other: string;
	env: NodeJS.ProcessEnv;
}

async function fixture(): Promise<Fixture> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "feedback-cwd-")));
	roots.push(root);
	const sessions = join(root, "agent", "sessions");
	const project = join(root, "project");
	const other = join(root, "other");
	for (const directory of [project, other]) {
		const folder = join(sessions, `--${directory.replace(/^\//, "").replace(/[/:]/g, "-")}--`);
		await mkdir(folder, { recursive: true });
		await writeFile(
			join(folder, "2026-10-23T00-00-00-000Z_session.jsonl"),
			`${JSON.stringify({ type: "session", id: `session-${directory.split("/").pop()}`, cwd: directory })}\n`,
		);
	}
	return {
		root,
		sessions,
		project,
		other,
		env: {
			STEP_CODING_AGENT_DIR: join(root, "agent"),
			STEP_CODING_AGENT_SESSION_DIR: sessions,
			STEPCODE_STORAGE_ROOT_DIR: join(root, "storage"),
		} as NodeJS.ProcessEnv,
	};
}

describe("feedback session resolution follows the session's project", () => {
	test("resolves inside the project the caller names", async () => {
		const { project, env } = await fixture();
		const resolved = await resolveFeedbackSession({ env, cwd: project });
		expect(resolved?.sessionId).toBe("session-project");
	});

	test("another project resolves its own session", async () => {
		const { other, env } = await fixture();
		const resolved = await resolveFeedbackSession({ env, cwd: other });
		expect(resolved?.sessionId).toBe("session-other");
	});

	test("the evidence describes the session of the project it was given", async () => {
		const { other, env } = await fixture();
		const evidence = await prepareFeedbackEvidence({
			storageRootDir: env.STEPCODE_STORAGE_ROOT_DIR as string,
			cwd: other,
			withoutBundle: true,
			withoutDiagnostics: true,
			env,
		});
		expect(evidence.sessionId).toBe("session-other");
		expect(evidence.summary?.cwd?.endsWith("/other")).toBe(true);
	});

	test("a project with no session of its own attaches nothing", async () => {
		const { root, env } = await fixture();
		const empty = join(root, "empty-project");
		await mkdir(empty, { recursive: true });
		const evidence = await prepareFeedbackEvidence({
			storageRootDir: env.STEPCODE_STORAGE_ROOT_DIR as string,
			cwd: empty,
			withoutBundle: true,
			withoutDiagnostics: true,
			env,
		});
		// The fixture has other project folders, so crossing them is refused.
		expect(evidence.sessionId).toBeUndefined();
		expect(evidence.summary).toBeUndefined();
	});
});
