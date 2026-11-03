import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

interface CliBrandingProbe {
	appName: string;
	appTitle: string;
	configDirName: string;
	isStepEntrypoint: boolean;
	isStepStorageContext: boolean;
	agentDir: string;
	sessionsDir: string;
	defaultProvider: string | null;
	defaultModel: string | null;
	aiAgent: string | null;
	help: string;
	configHandled: boolean;
	configHelp: string;
}

export function runCliBrandingProbe(overrides: NodeJS.ProcessEnv = {}): CliBrandingProbe {
	const env = { ...process.env };
	for (const name of Object.keys(env)) {
		if (name.startsWith("STEP_") || name.startsWith("PI_") || name === "AI_AGENT") delete env[name];
	}
	const child = spawnSync(
		process.execPath,
		[
			"--import",
			import.meta.resolve("tsx"),
			fileURLToPath(new URL("./fixtures/cli-branding-probe.ts", import.meta.url)),
		],
		{
			cwd: fileURLToPath(new URL("../../../", import.meta.url)),
			env: { ...env, ...overrides, FORCE_COLOR: "0" },
			encoding: "utf8",
			timeout: 20_000,
		},
	);
	if (child.error) throw child.error;
	if (child.status !== 0) throw new Error(`CLI branding probe exited ${child.status}: ${child.stderr}`);
	return JSON.parse(child.stdout) as CliBrandingProbe;
}
