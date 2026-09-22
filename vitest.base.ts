import { fileURLToPath } from "node:url";

export const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/providers/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/providers/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/providers/src/oauth.ts", import.meta.url)),
	stepProvider: fileURLToPath(new URL("./packages/providers/src/step-provider/index.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/providers/src/providers", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent-core/src/index.ts", import.meta.url)),
	agentNode: fileURLToPath(new URL("./packages/agent-core/src/node.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
	configIndex: fileURLToPath(new URL("./packages/config/src/index.ts", import.meta.url)),
} as const;

export default {
	resolve: {
		alias: [
			{ find: /^@step-harness\/telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@step-harness\/telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@step-harness\/providers$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@step-harness\/providers\/step-provider$/, replacement: workspaceSourcePaths.stepProvider },
			{ find: /^@step-harness\/providers\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@step-harness\/providers\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@step-harness\/providers\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@step-harness\/agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@step-harness\/agent-core\/node$/, replacement: workspaceSourcePaths.agentNode },
			{ find: /^@step-harness\/coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
			{ find: /^@step-harness\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			{ find: /^@step-harness\/config$/, replacement: workspaceSourcePaths.configIndex },
			// A1 backward-compat: legacy @earendil-works/pi-* specifiers (used by example
			// extensions and old user extensions) resolve to the same renamed sources.
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@earendil-works\/pi-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@earendil-works\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@earendil-works\/pi-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
			{ find: /^@earendil-works\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
};
