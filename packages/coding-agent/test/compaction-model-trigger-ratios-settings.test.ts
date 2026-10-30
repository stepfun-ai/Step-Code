import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStepSettingsManager } from "../src/step/settings-manager.ts";

describe("global per-model compaction trigger ratios", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function fixture(configToml?: string): { home: string; agentDir: string; configPath: string } {
		const home = mkdtempSync(join(tmpdir(), "step-trigger-ratios-"));
		roots.push(home);
		const configRoot = join(home, ".stepcode");
		const agentDir = join(configRoot, "agent");
		mkdirSync(agentDir, { recursive: true });
		const configPath = join(configRoot, "config.toml");
		if (configToml !== undefined) writeFileSync(configPath, configToml);
		return { home, agentDir, configPath };
	}

	it("round-trips provider/model keys through config.toml and keeps sibling compaction settings", async () => {
		const { home, agentDir, configPath } = fixture(
			'[compaction]\ntriggerRatio = 0.85\n\n[compaction.modelTriggerRatios]\n"other/model" = 0.8\n',
		);
		const manager = createStepSettingsManager(home, agentDir, { configDirName: ".stepcode" });
		expect(manager.getGlobalCompactionModelTriggerRatios()).toEqual({ "other/model": 0.8 });

		manager.updateGlobalCompactionModelTriggerRatios((current) => ({ ...current, "gw/claude-opus-5.5": 0.7 }));
		await manager.flush();
		expect(manager.drainErrors()).toEqual([]);

		const reread = createStepSettingsManager(home, agentDir, { configDirName: ".stepcode" });
		expect(reread.getGlobalCompactionModelTriggerRatios()).toEqual({ "other/model": 0.8, "gw/claude-opus-5.5": 0.7 });
		expect(reread.getCompactionTriggerSettings().triggerRatio).toBe(0.85);
		expect(readFileSync(configPath, "utf8")).toContain("triggerRatio = 0.85");
	});

	it("removes entries the update drops", async () => {
		const { home, agentDir } = fixture('[compaction.modelTriggerRatios]\n"gw/a" = 0.6\n"gw/b" = 0.7\n"x/c" = 0.8\n');
		const manager = createStepSettingsManager(home, agentDir, { configDirName: ".stepcode" });
		manager.updateGlobalCompactionModelTriggerRatios((current) =>
			Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith("gw/"))),
		);
		await manager.flush();
		const reread = createStepSettingsManager(home, agentDir, { configDirName: ".stepcode" });
		expect(reread.getGlobalCompactionModelTriggerRatios()).toEqual({ "x/c": 0.8 });
	});

	it("rejects a ratio outside the trigger policy range without writing", async () => {
		const { home, agentDir, configPath } = fixture('[compaction.modelTriggerRatios]\n"gw/a" = 0.6\n');
		const before = readFileSync(configPath, "utf8");
		for (const bad of [0.99, 0.4]) {
			const manager = createStepSettingsManager(home, agentDir, { configDirName: ".stepcode" });
			manager.updateGlobalCompactionModelTriggerRatios(() => ({ "gw/a": bad }));
			await manager.flush();
			const errors = manager.drainErrors();
			expect(errors.map((error) => error.error.message).join("\n")).toMatch(/must be a number in 0\.5-0\.95/u);
		}
		expect(readFileSync(configPath, "utf8")).toBe(before);
	});

	it("keeps entries it does not own byte-for-byte, even ones the trigger policy ignores", async () => {
		const { home, agentDir } = fixture('[compaction.modelTriggerRatios]\n"bad/z" = 0.4\n"gw/a" = 0.6\n');
		const manager = createStepSettingsManager(home, agentDir, { configDirName: ".stepcode" });
		manager.drainErrors();
		manager.updateGlobalCompactionModelTriggerRatios((current) => ({ ...current, "gw/a": 0.7 }));
		await manager.flush();
		expect(manager.drainErrors()).toEqual([]);
		const reread = createStepSettingsManager(home, agentDir, { configDirName: ".stepcode" });
		expect(reread.getGlobalSettings().compaction?.modelTriggerRatios).toEqual({ "bad/z": 0.4, "gw/a": 0.7 });
	});

	it("reads the table under the lock, so a key written after the manager loaded survives", async () => {
		const { home, agentDir, configPath } = fixture('[compaction.modelTriggerRatios]\n"gw/a" = 0.6\n');
		const manager = createStepSettingsManager(home, agentDir, { configDirName: ".stepcode" });
		writeFileSync(configPath, '[compaction.modelTriggerRatios]\n"gw/a" = 0.6\n"cli/m" = 0.75\n');
		manager.updateGlobalCompactionModelTriggerRatios((current) => ({ ...current, "gw/b": 0.8 }));
		await manager.flush();
		const reread = createStepSettingsManager(home, agentDir, { configDirName: ".stepcode" });
		expect(reread.getGlobalCompactionModelTriggerRatios()).toEqual({ "gw/a": 0.6, "cli/m": 0.75, "gw/b": 0.8 });
		expect(manager.getGlobalCompactionModelTriggerRatios()).toEqual({ "gw/a": 0.6, "cli/m": 0.75, "gw/b": 0.8 });
	});

	it("removes the table when the last entry goes, and writes nothing when nothing changes", async () => {
		const { home, agentDir, configPath } = fixture(
			'[compaction]\ntriggerRatio = 0.85\n\n[compaction.modelTriggerRatios]\n"gw/a" = 0.6\n',
		);
		const manager = createStepSettingsManager(home, agentDir, { configDirName: ".stepcode" });
		manager.updateGlobalCompactionModelTriggerRatios(() => ({}));
		await manager.flush();
		const cleared = readFileSync(configPath, "utf8");
		expect(cleared).not.toContain("modelTriggerRatios");
		expect(cleared).toContain("triggerRatio = 0.85");
		manager.updateGlobalCompactionModelTriggerRatios(() => ({}));
		await manager.flush();
		expect(readFileSync(configPath, "utf8")).toBe(cleared);
	});

	it("refuses to write when the user config cannot be loaded", async () => {
		const { home, agentDir, configPath } = fixture("[compaction\nbroken = ");
		const manager = createStepSettingsManager(home, agentDir, { configDirName: ".stepcode" });
		expect(() => manager.updateGlobalCompactionModelTriggerRatios(() => ({ "gw/a": 0.7 }))).toThrow(
			/could not be loaded/u,
		);
		await manager.flush();
		expect(readFileSync(configPath, "utf8")).toBe("[compaction\nbroken = ");
	});
});
