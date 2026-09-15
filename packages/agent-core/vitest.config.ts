import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../providers/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../providers/src/compat.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [
			{ find: /^@step-harness\/telemetry$/, replacement: telemetrySrcIndex },
			{ find: /^@step-harness\/agent-core$/, replacement: agentSrcIndex },
			{ find: /^@step-harness\/providers$/, replacement: aiSrcIndex },
			{ find: /^@step-harness\/providers\/compat$/, replacement: aiSrcCompat },
		],
	},
});
