import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliBrandingProbe } from "./cli-branding-probe.ts";

describe("coding-agent config distribution isolation", () => {
	test("keeps generic storage and provider defaults with the step display name", () => {
		const result = runCliBrandingProbe({ STEPCODE_APP_NAME: "stale-step", STEPCODE_CONFIG_DIR: ".stale-step" });

		expect(result.appName).toBe("step");
		expect(result.appTitle).toBe("step");
		expect(result.isStepEntrypoint).toBe(false);
		expect(result.isStepStorageContext).toBe(false);
		expect(result.configDirName).toBe(".pi");
		expect(result.agentDir).toBe(join(homedir(), ".pi", "agent"));
		expect(result.sessionsDir).toBe(join(homedir(), ".pi", "agent", "sessions"));
		expect(result.defaultProvider).toBeNull();
		expect(result.defaultModel).toBeNull();
		expect(result.aiAgent).toBeNull();
	});

	test("Step entrypoint accepts distribution overrides and applies product defaults", () => {
		const result = runCliBrandingProbe({
			STEPCODE_ENTRYPOINT: "1",
			STEPCODE_APP_NAME: "custom-assistant",
			STEPCODE_CONFIG_DIR: ".custom-assistant",
		});

		expect(result.appName).toBe("custom-assistant");
		expect(result.appTitle).toBe("custom-assistant");
		expect(result.isStepEntrypoint).toBe(true);
		expect(result.isStepStorageContext).toBe(true);
		expect(result.configDirName).toBe(".custom-assistant");
		expect(result.agentDir).toBe(join(homedir(), ".custom-assistant", "agent"));
		expect(result.sessionsDir).toBe(join(homedir(), ".custom-assistant", "agent", "sessions"));
		expect(result.defaultProvider).toBe("step");
		expect(result.defaultModel).toBe("step-5-preview");
		expect(result.aiAgent).toBe("step");
	});
});
