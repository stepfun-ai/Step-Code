import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { StepSubagentRunInput } from "../src/features/step-subagent.ts";
import { liveSubagentSessions } from "../src/features/subagent/lane-lifecycle.ts";
import { createSubagentRpcSession } from "../src/features/subagent/rpc-adapter.ts";

const subagentTempRemovals = vi.hoisted(() => [] as string[]);

// Simulate Windows refusing to remove the subagent temp dir (EPERM on rmdir);
// every other path is removed for real.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rm: async (target: string, options?: Parameters<typeof actual.rm>[1]) => {
			if (path.basename(String(target)).startsWith("stepcode-subagent-")) {
				subagentTempRemovals.push(String(target));
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

const workspaces: string[] = [];

afterEach(async () => {
	liveSubagentSessions.clear();
	subagentTempRemovals.length = 0;
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

// Regression: on Windows the web host crashed with an unhandled
// `EPERM: operation not permitted, rmdir ...\\stepcode-subagent-*` after a
// subagent exited. Exit handling fired twice and raced two unawaited removals.
test("a failed temp dir removal after child exit is attempted once and never escapes as an unhandled rejection", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	const originalArgv1 = process.argv[1];
	process.argv[1] = await fakeChild();
	try {
		const session = await createSubagentRpcSession(runInput(), "temp-dir-cleanup-test");
		session.stop();
		await session.exited;
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(subagentTempRemovals).toHaveLength(1);
		expect(unhandled).toEqual([]);

		// A later terminate must not race the removal that already ran.
		session.terminate();
		expect(subagentTempRemovals).toHaveLength(1);
	} finally {
		process.argv[1] = originalArgv1;
		process.off("unhandledRejection", onUnhandled);
	}
}, 20_000);
