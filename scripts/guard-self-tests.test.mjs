import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Every guard that ships a `--self-test` convention. The self-tests assert the
// guard's own detection logic against known clean/violation fixtures, but they
// were only ever run by hand — so a guard whose logic silently broke would keep
// reporting "passed" in CI. This suite runs each guard's --self-test under
// `node --test scripts/*.test.mjs` (wired into `pnpm run test:scripts`) so a
// broken guard fails the build.
const guardsWithSelfTest = [
	"check-layer-direction.mjs",
	"check-ui-layer.mjs",
	"check-workspace-registry.mjs",
	"check-tui-no-ai.mjs",
	"check-coding-agent-entry-freeze.mjs",
	"check-contracts-deps-empty.mjs",
	"check-pinned-deps.mjs",
	"check-ts-relative-imports.mjs",
	"check-derived-compat-only.mjs",
	"check-no-provider-dispatch.mjs",
	"check-metadata-not-in-dispatch.mjs",
	"check-no-secret-leak.mjs",
	"check-legacy-scope-prefix.mjs",
	"check-no-observability.mjs",
	"check-public-boundary.mjs",
];

for (const guard of guardsWithSelfTest) {
	test(`${guard} --self-test passes`, () => {
		const guardPath = fileURLToPath(new URL(`./${guard}`, import.meta.url));
		const result = spawnSync(process.execPath, [guardPath, "--self-test"], { encoding: "utf8" });
		assert.equal(
			result.status,
			0,
			`${guard} --self-test exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	});
}
