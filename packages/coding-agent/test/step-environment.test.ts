import { describe, expect, test } from "vitest";
import { getStepDefaultTheme } from "../src/step/defaults.ts";
import { applyStepEnvironment, isStepEntrypoint, resolveStepSessionDir } from "../src/step/environment.ts";

describe("Step early environment", () => {
	test("seeds the single blue theme for a clean launch", () => {
		const env: NodeJS.ProcessEnv = {};

		applyStepEnvironment(env);

		expect(getStepDefaultTheme(env)).toBe("step-blue");
	});

	test("recognizes source, bundled, and binary launchers", () => {
		expect(isStepEntrypoint(["node", "/tmp/step-cli.ts"])).toBe(true);
		expect(isStepEntrypoint(["node", "/tmp/step.js"])).toBe(true);
		expect(isStepEntrypoint(["node", "/tmp/step-bin"])).toBe(true);
		expect(isStepEntrypoint(["node", "/tmp/step-helper.js"])).toBe(false);
		expect(isStepEntrypoint(["node", "/tmp/step"])).toBe(true);
		expect(isStepEntrypoint(["/tmp/step", "--help"])).toBe(true);
		expect(isStepEntrypoint(["/tmp/step-cli", "--help"])).toBe(true);
		expect(isStepEntrypoint(["node", "/tmp/cli.js"])).toBe(false);
		expect(isStepEntrypoint(["node", "/repo/node_modules/.bin/tsx", "/repo/src/step-cli.ts"])).toBe(true);
		expect(isStepEntrypoint(["node", "/repo/node_modules/.bin/tsx", "step"])).toBe(false);
	});

	test("sets isolated product defaults without overwriting explicit values", () => {
		const env: NodeJS.ProcessEnv = {
			STEP_PROVIDER: "custom-provider",
			STEP_MODEL: "custom-model",
			STEP_CLI_DEFAULT_THEME: "custom-theme",
			PI_CODING_AGENT: "parent-value",
		};

		applyStepEnvironment(env);

		expect(env.STEP_CLI_APP_NAME).toBe("step");
		expect(env.STEP_CLI_CONFIG_DIR).toBe(".step-cli");
		expect(env.STEP_CLI_DEFAULT_THEME).toBe("custom-theme");
		expect(env.STEP_CLI_DEFAULT_PROVIDER).toBe("custom-provider");
		expect(env.STEP_CLI_DEFAULT_MODEL).toBe("custom-model");
		expect(env.STEP_CODING_AGENT_DIR).toMatch(/\.step-cli[\\/]agent$/u);
		// pi-tui still has a historical fallback that reads this alias directly;
		// the Step bootstrap mirrors the resolved root for that wrapped surface.
		expect(env.PI_CODING_AGENT_DIR).toBe(env.STEP_CODING_AGENT_DIR);
		// No session override is injected: Pi's SessionManager derives the
		// default from the resolved agent directory.
		expect(env.STEP_CODING_AGENT_SESSION_DIR).toBeUndefined();
		expect(env.STEP_CLI_DISABLE_PI_SERVICES).toBe("1");
		expect(env.PI_CODING_AGENT).toBe("true");
		expect(env.AI_AGENT).toBe("step");

		env.STEP_CLI_APP_NAME = "custom-app";
		env.STEP_CLI_CONFIG_DIR = "custom-config";
		env.STEP_CODING_AGENT_DIR = "/custom/agent";
		applyStepEnvironment(env);
		expect(env.STEP_CLI_APP_NAME).toBe("custom-app");
		expect(env.STEP_CLI_CONFIG_DIR).toBe("custom-config");
		expect(env.STEP_CODING_AGENT_DIR).toBe("/custom/agent");
	});

	test("keeps an explicit session override", () => {
		const env: NodeJS.ProcessEnv = {
			STEP_CODING_AGENT_SESSION_DIR: "/tmp/step-sessions",
		};

		applyStepEnvironment(env);

		expect(env.STEP_CODING_AGENT_SESSION_DIR).toBe("/tmp/step-sessions");
		expect(resolveStepSessionDir(env)).toBe("/tmp/step-sessions");
	});

	test("derives the default session directory below the agent directory", () => {
		const env: NodeJS.ProcessEnv = {
			STEP_CODING_AGENT_DIR: "/tmp/step-agent",
		};

		expect(resolveStepSessionDir(env)).toBe("/tmp/step-agent/sessions");
	});
});
