import { printHelp } from "../../src/cli/args.ts";
import {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	getAgentDir,
	getSessionsDir,
	IS_STEP_ENTRYPOINT,
} from "../../src/config.ts";
import { handleConfigCommand } from "../../src/package-manager-cli.ts";
import { isStepStorageContext } from "../../src/step/environment.ts";

// Keep imports static: entrypoint configuration must be applied during module evaluation.
const lines: string[] = [];
console.log = (chunk: unknown) => {
	lines.push(String(chunk));
};
printHelp();
const help = lines.join("\n");
lines.length = 0;
const configHandled = await handleConfigCommand(["config", "--help"]);

process.stdout.write(
	JSON.stringify({
		appName: APP_NAME,
		appTitle: APP_TITLE,
		configDirName: CONFIG_DIR_NAME,
		isStepEntrypoint: IS_STEP_ENTRYPOINT,
		isStepStorageContext: isStepStorageContext(),
		agentDir: getAgentDir(),
		sessionsDir: getSessionsDir(),
		defaultProvider: process.env.STEPCODE_DEFAULT_PROVIDER ?? null,
		defaultModel: process.env.STEPCODE_DEFAULT_MODEL ?? null,
		aiAgent: process.env.AI_AGENT ?? null,
		help,
		configHandled,
		configHelp: lines.join("\n"),
	}),
);
