/**
 * Runner hook for scripts/render-equivalence.test.mts.
 *
 * The root suite globs scripts/*.test.mjs, and the equivalence test has to be .mts
 * because it drives TypeScript sources from packages/ through tsx (packages/tui must
 * not import from coding-agent, which is why the matrix lives in scripts/ at all).
 * This shim keeps the existing glob intact and adds the file to the normal suite:
 * node --test picks this up, and it runs the real test through tsx in a child
 * process so the kill switch still latches per process.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("render equivalence (cached vs cache-free byte stream)", () => {
	const script = fileURLToPath(new URL("./render-equivalence.test.mts", import.meta.url));
	const result = spawnSync(
		process.execPath,
		["node_modules/tsx/dist/cli.mjs", "--tsconfig", "tsconfig.json", script],
		{
			encoding: "utf8",
			cwd: repoRoot,
			env: process.env,
			maxBuffer: 256 * 1024 * 1024,
		},
	);
	// Surface the matrix table and the diagnostics from the child run.
	process.stdout.write(result.stdout ?? "");
	process.stderr.write(result.stderr ?? "");
	assert.equal(result.status, 0, "render equivalence test failed");
});
