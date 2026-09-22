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
			// Blank ambient provider credentials so tests are deterministic
			// regardless of the developer's shell. If any of these are set
			// (e.g. stepcode exports ANTHROPIC_AUTH_TOKEN), a builtin provider's
			// `checkAuth` marks it "configured" and its static offline catalog
			// leaks into ModelSelector/model-registry snapshots — which flaked
			// the #6999/#7209 model-selector tests locally while passing in CI.
			// Tests that need credentials set them explicitly via vi.stubEnv.
			env: {
				// Force color OFF so TUI-render assertions are deterministic across
				// shells. With truecolor on (e.g. stepcode sets FORCE_COLOR=3), the
				// theme interleaves ANSI spans inside diff values, so raw substring
				// checks like `render.includes("line 50 changed")` fail locally while
				// passing in CI (no forced color). See edit-tool-no-full-redraw.test.
				FORCE_COLOR: "0",
				ANTHROPIC_AUTH_TOKEN: "",
				ANTHROPIC_OAUTH_TOKEN: "",
				ANTHROPIC_API_KEY: "",
				ANTHROPIC_BASE_URL: "",
				OPENAI_API_KEY: "",
				STEP_API_KEY: "",
			},
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
		},
	}),
);
