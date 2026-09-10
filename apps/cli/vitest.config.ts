import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

// apps/cli owns the process entry; its tests are plain unit tests (no network).
// Mirrors the coding-agent vitest setup so `pnpm --filter @step-harness/cli test`
// resolves a real vitest binary and runs apps/cli/test/*.test.ts.
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			env: { PI_OFFLINE: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
		},
	}),
);
