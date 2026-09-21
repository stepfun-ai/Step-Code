import { describe, expect, test } from "vitest";
import { getStepDefaultTheme } from "../src/step/defaults.ts";
import { applyStepEnvironment, isStepEntrypoint, resolveStepSessionDir } from "../src/step/environment.ts";

describe("Step early environment", () => {
	test("seeds the single blue theme for a clean launch", () => {
		const env: NodeJS.ProcessEnv = {};

		applyStepEnvironment(env);

		expect(getStepDefaultTheme(env)).toBe("step-blue");
	});

	test("defaults the downstream client marker to stepcode, honoring an explicit value", () => {
		const fresh: NodeJS.ProcessEnv = {};
		applyStepEnvironment(fresh);
		expect(fresh.STEP_CLIENT).toBe("stepcode");

		const explicit: NodeJS.ProcessEnv = { STEP_CLIENT: "embedding-host" };
		applyStepEnvironment(explicit);
		expect(explicit.STEP_CLIENT).toBe("embedding-host");

		const blank: NodeJS.ProcessEnv = { STEP_CLIENT: "   " };
		applyStepEnvironment(blank);
		expect(blank.STEP_CLIENT).toBe("stepcode");
	});

	test("recognizes source, bundled, and binary launchers", () => {
		expect(isStepEntrypoint(["node", "/tmp/stepcode.ts"])).toBe(true);
		expect(isStepEntrypoint(["node", "/tmp/step.js"])).toBe(true);
		expect(isStepEntrypoint(["node", "/tmp/step-bin"])).toBe(true);
		expect(isStepEntrypoint(["node", "/tmp/step-helper.js"])).toBe(false);
		expect(isStepEntrypoint(["node", "/tmp/step"])).toBe(true);
		expect(isStepEntrypoint(["/tmp/step", "--help"])).toBe(true);
		expect(isStepEntrypoint(["/tmp/stepcode", "--help"])).toBe(true);
		expect(isStepEntrypoint(["node", "/tmp/cli.js"])).toBe(false);
		expect(isStepEntrypoint(["node", "/repo/node_modules/.bin/tsx", "/repo/src/stepcode.ts"])).toBe(true);
		expect(isStepEntrypoint(["node", "/repo/node_modules/.bin/tsx", "step"])).toBe(false);
	});

	test("sets isolated product defaults without overwriting explicit values", () => {
		const env: NodeJS.ProcessEnv = {
			STEP_PROVIDER: "custom-provider",
			STEP_MODEL: "custom-model",
			STEPCODE_DEFAULT_THEME: "custom-theme",
			CUSTOM_PARENT_VALUE: "parent-value",
		};

		applyStepEnvironment(env);

		expect(env.STEPCODE_APP_NAME).toBe("step");
		expect(env.STEPCODE_CONFIG_DIR).toBe(".stepcode");
		expect(env.STEPCODE_DEFAULT_THEME).toBe("custom-theme");
		expect(env.STEPCODE_DEFAULT_PROVIDER).toBe("custom-provider");
		expect(env.STEPCODE_DEFAULT_MODEL).toBe("custom-model");
		expect(env.STEP_CODING_AGENT_DIR).toMatch(/\.stepcode[\\/]agent$/u);
		// No session override is injected: Pi's SessionManager derives the
		// default from the resolved agent directory.
		expect(env.STEP_CODING_AGENT_SESSION_DIR).toBeUndefined();
		expect(env.STEPCODE_DISABLE_PI_SERVICES).toBe("1");
		expect(env.CUSTOM_PARENT_VALUE).toBe("parent-value");
		expect(env.AI_AGENT).toBe("step");

		env.STEPCODE_APP_NAME = "custom-app";
		env.STEPCODE_CONFIG_DIR = "custom-config";
		env.STEP_CODING_AGENT_DIR = "/custom/agent";
		applyStepEnvironment(env);
		expect(env.STEPCODE_APP_NAME).toBe("custom-app");
		expect(env.STEPCODE_CONFIG_DIR).toBe("custom-config");
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
