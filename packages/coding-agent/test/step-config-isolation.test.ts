import { afterEach, describe, expect, test, vi } from "vitest";

const originalArgv1 = process.argv[1];
const stepEnvNames = [
	"STEPCODE_APP_NAME",
	"STEPCODE_CONFIG_DIR",
	"STEP_CODING_AGENT_DIR",
	"STEP_CODING_AGENT_SESSION_DIR",
] as const;
const originalStepEnv = Object.fromEntries(stepEnvNames.map((name) => [name, process.env[name]]));

afterEach(() => {
	if (originalArgv1 === undefined) delete process.argv[1];
	else process.argv[1] = originalArgv1;
	for (const name of stepEnvNames) {
		const value = originalStepEnv[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	vi.resetModules();
});

describe("coding-agent config distribution isolation", () => {
	test("ordinary pi ignores stale Step app and config directory variables", async () => {
		process.argv[1] = "/tmp/cli.js";
		process.env.STEPCODE_APP_NAME = "stale-step";
		process.env.STEPCODE_CONFIG_DIR = ".stale-step";

		vi.resetModules();
		const config = await import("../src/config.ts");

		expect(config.APP_NAME).toBe("pi");
		expect(config.CONFIG_DIR_NAME).toBe(".pi");
	});

	test("Step entrypoint accepts distribution overrides", async () => {
		process.argv[1] = "/tmp/step";
		process.env.STEPCODE_APP_NAME = "step-custom";
		process.env.STEPCODE_CONFIG_DIR = ".step-custom";

		vi.resetModules();
		const config = await import("../src/config.ts");

		expect(config.APP_NAME).toBe("step-custom");
		expect(config.CONFIG_DIR_NAME).toBe(".step-custom");
	});
});
