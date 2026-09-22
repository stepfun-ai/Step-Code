import { describe, expect, test } from "vitest";
import { STEP_CONFIG_SUBCOMMANDS } from "../src/step/command-compat.ts";
import { runCliBrandingProbe } from "./cli-branding-probe.ts";

describe("config --help subcommands", () => {
	test("keeps Step-only help gated by the entrypoint when the generic display name is step", () => {
		const result = runCliBrandingProbe();

		expect(result.appName).toBe("step");
		expect(result.isStepEntrypoint).toBe(false);
		expect(result.configHandled).toBe(true);
		expect(result.configHelp).toContain("step config [-l]");
		expect(result.configHelp).not.toContain("Subcommands:");
		expect(result.help).toContain("default: google");
		expect(result.help).not.toMatch(/^\s+step (?:login|logout)\s/m);
		expect(result.help).not.toContain("--approval-mode <mode>");
		expect(result.help).not.toContain("STEP_APPROVAL_MODE");
	});

	test.each(["step", "custom-assistant"])(
		"lists Step commands and config subcommands for the %s display name",
		(appName) => {
			const result = runCliBrandingProbe({ STEPCODE_ENTRYPOINT: "1", STEPCODE_APP_NAME: appName });

			expect(result.appName).toBe(appName);
			expect(result.isStepEntrypoint).toBe(true);
			expect(result.configHandled).toBe(true);
			expect(result.configHelp).toContain(`${appName} config [-l]`);
			expect(STEP_CONFIG_SUBCOMMANDS.map((sub) => sub.name)).toEqual(["path", "show", "init"]);
			for (const { name } of STEP_CONFIG_SUBCOMMANDS) {
				expect(result.configHelp).toMatch(new RegExp(`^\\s+${name}\\s`, "m"));
			}
			expect(result.help).toContain("default: step");
			expect(result.help).toContain(`${appName} login`);
			expect(result.help).toContain(`${appName} logout`);
			expect(result.help).toContain("--approval-mode <mode>");
			expect(result.help).toContain("STEP_APPROVAL_MODE");
		},
	);
});
