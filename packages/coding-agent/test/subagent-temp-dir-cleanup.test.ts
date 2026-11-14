import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { StepSubagentRunInput } from "../src/features/step-subagent.ts";
import { liveSubagentSessions } from "../src/features/subagent/lane-lifecycle.ts";
import { createSubagentRpcSession } from "../src/features/subagent/rpc-adapter.ts";

const removals = vi.hoisted(() => ({ async: [] as string[], sync: [] as string[] }));

function isSubagentTempDir(target: unknown): boolean {
	return path.basename(String(target)).startsWith("stepcode-subagent-");
}

// Simulate Windows refusing to remove the subagent temp dir (EPERM on rmdir);
// every other path is removed for real.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rm: async (target: string, options?: Parameters<typeof actual.rm>[1]) => {
			if (isSubagentTempDir(target)) {
				removals.async.push(String(target));
				await actual.rm(target, options);
				throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${target}'`), {
					code: "EPERM",
					syscall: "rmdir",
				});
			}
			return actual.rm(target, options);
		},
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		rmSync: (target: string, options?: Parameters<typeof actual.rmSync>[1]) => {
			if (isSubagentTempDir(target)) removals.sync.push(String(target));
			return actual.rmSync(target, options);
		},
	};
});

const workspaces: string[] = [];

afterEach(async () => {
	liveSubagentSessions.clear();
	removals.async.length = 0;
	removals.sync.length = 0;
	await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runInput(): StepSubagentRunInput {
	return {
		agent: { name: "general", description: "test agent", systemPrompt: "you are a test agent", source: "builtin" },
		task: "do the thing",
		cwd: process.cwd(),
	};
}

/** Fake `step --mode rpc` child that exits cleanly when its stdin closes. */
async function fakeChild(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "step-subagent-cleanup-"));
	workspaces.push(dir);
	const file = path.join(dir, "fake-child.mjs");
	await writeFile(file, `process.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));\n`, "utf8");
	return file;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

async function withFakeChild(run: () => Promise<void>): Promise<unknown[]> {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	const originalArgv1 = process.argv[1];
	process.argv[1] = await fakeChild();
	try {
		await run();
		return unhandled;
	} finally {
		process.argv[1] = originalArgv1;
		process.off("unhandledRejection", onUnhandled);
	}
}

// Regression: on Windows the web host crashed with an unhandled
// `EPERM: operation not permitted, rmdir ...\\stepcode-subagent-*` after a
// subagent exited. Exit handling fired twice and raced two unawaited removals.
test("a failed temp dir removal after child exit is attempted once and never escapes as an unhandled rejection", async () => {
	const unhandled = await withFakeChild(async () => {
		const session = await createSubagentRpcSession(runInput(), "temp-dir-cleanup-exit-test");
		session.stop();
		await session.exited;
		await settle();
		expect(removals.async).toHaveLength(1);

		// The async removal already owns the directory, so terminate must not race it.
		session.terminate();
		expect(removals.sync).toEqual([]);
	});
	expect(unhandled).toEqual([]);
}, 20_000);

test("terminate removes the temp dir synchronously and the later exit does not remove it again", async () => {
	const unhandled = await withFakeChild(async () => {
		const session = await createSubagentRpcSession(runInput(), "temp-dir-cleanup-terminate-test");
		session.terminate();
		expect(removals.sync).toHaveLength(1);
		await session.exited;
		await settle();
		expect(removals.async).toEqual([]);
	});
	expect(unhandled).toEqual([]);
}, 20_000);
