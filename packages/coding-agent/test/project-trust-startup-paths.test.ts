import { describe, expect, test } from "vitest";
import { createProjectTrustContext } from "../src/cli/project-trust.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("createProjectTrustContext paths", () => {
	test("forwards the startup paths (including cwd) to the selector primitives", async () => {
		const seen: unknown[] = [];
		const context = createProjectTrustContext({
			cwd: "/work/dir",
			mode: "interactive",
			settingsManager: SettingsManager.inMemory(),
			hasUI: true,
			// Same shape main.ts builds for the trust prompt: the runtime cwd rides
			// along so the startup selectors discover project-level themes in the
			// -C target directory, not the launcher directory.
			paths: { agentDir: "/agent", configDirName: ".stepcode", cwd: "/work/dir" },
			ui: {
				showStartupSelector: async <T>(
					_settingsManager: SettingsManager,
					_title: string,
					_options: Array<{ label: string; value: T }>,
					paths?: unknown,
				) => {
					seen.push(paths);
					return "trust" as T;
				},
			},
		});

		await context.ui.select("Trust this directory?", ["trust", "decline"]);

		expect(seen).toEqual([{ agentDir: "/agent", configDirName: ".stepcode", cwd: "/work/dir" }]);
	});

	test("keeps paths undefined when the caller supplies none", async () => {
		const seen: unknown[] = [];
		const context = createProjectTrustContext({
			cwd: "/work/dir",
			mode: "interactive",
			settingsManager: SettingsManager.inMemory(),
			hasUI: true,
			ui: {
				showStartupSelector: async <T>(
					_settingsManager: SettingsManager,
					_title: string,
					_options: Array<{ label: string; value: T }>,
					paths?: unknown,
				) => {
					seen.push(paths);
					return "trust" as T;
				},
			},
		});

		await context.ui.select("Trust this directory?", ["trust"]);

		expect(seen).toEqual([undefined]);
	});
});
