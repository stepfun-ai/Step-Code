import { describe, expect, test, vi } from "vitest";
import type { SettingsManager } from "../../../packages/coding-agent/src/core/settings-manager.ts";

const packageManagerMocks = vi.hoisted(() => {
	const instance = { resolve: vi.fn<(fn: () => Promise<string>) => Promise<{ themes: never[] }>>() };
	return { instance, ctor: vi.fn<(options: { cwd: string }) => typeof instance>() };
});

// Capture the cwd the startup theme discovery builds its package manager with.
vi.mock("@step-harness/coding-agent", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		DefaultPackageManager: class {
			constructor(options: { cwd: string }) {
				packageManagerMocks.ctor(options);
				return packageManagerMocks.instance as unknown as this;
			}
		},
	};
});

const { loadStartupThemes } = await import("../src/ui/startup-ui.ts");

function fakeSettingsManager(): SettingsManager {
	return {
		getGlobalSettings: () => ({}),
	} as unknown as SettingsManager;
}

describe("loadStartupThemes discovery base", () => {
	test("discovers project-level themes against the resolved cwd, not the launcher", async () => {
		packageManagerMocks.instance.resolve.mockResolvedValue({ themes: [] });

		await loadStartupThemes(fakeSettingsManager(), {
			agentDir: "/agent",
			configDirName: ".stepcode",
			cwd: "/target/project",
		});

		expect(packageManagerMocks.ctor).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/target/project" }),
		);
	});
});
