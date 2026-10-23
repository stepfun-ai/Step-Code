import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { readStepConfig, writeStepConfig } from "../src/step/config-toml.ts";
import { createStepSettingsManager } from "../src/step/settings-manager.ts";
import { decorateStepCodeSettingsManager, loadStepCodeConfig } from "../src/step/stepcode-config.ts";

describe("recent models", () => {
	let directory: string | undefined;
	afterEach(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
		directory = undefined;
	});

	it("persists the ten most recent provider/model pairs without changing defaults", async () => {
		const storage = new InMemorySettingsStorage();
		const manager = SettingsManager.fromStorage(storage);
		manager.setDefaultModelAndProvider("default", "startup");
		for (let i = 0; i < 12; i++) manager.recordRecentModel("provider", `model-${i}`);
		manager.recordRecentModel("other", "model-11");
		manager.recordRecentModel("provider", "model-10");
		await manager.flush();
		const restarted = SettingsManager.fromStorage(storage);
		expect(restarted.getRecentModels()).toEqual([
			{ provider: "provider", id: "model-10" },
			{ provider: "other", id: "model-11" },
			{ provider: "provider", id: "model-11" },
			...Array.from({ length: 7 }, (_, i) => ({ provider: "provider", id: `model-${9 - i}` })),
		]);
		expect(restarted.getDefaultProvider()).toBe("default");
		expect(restarted.getDefaultModel()).toBe("startup");
	});

	it("merges selections from concurrent managers under the storage lock", async () => {
		const storage = new InMemorySettingsStorage();
		const first = SettingsManager.fromStorage(storage);
		const second = SettingsManager.fromStorage(storage);
		first.recordRecentModel("provider", "first");
		await first.flush();
		second.recordRecentModel("provider", "second");
		await second.flush();
		expect(SettingsManager.fromStorage(storage).getRecentModels()).toEqual([
			{ provider: "provider", id: "second" },
			{ provider: "provider", id: "first" },
		]);
	});

	it("ignores malformed history, deduplicates it, and returns a defensive copy", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				recentModels: [null, {}, { provider: "p", id: "m" }, { provider: "p", id: "m" }, { provider: "p", id: 1 }],
			}),
		);
		const manager = SettingsManager.fromStorage(storage);
		const recent = manager.getRecentModels();
		expect(recent).toEqual([{ provider: "p", id: "m" }]);
		recent[0].id = "changed";
		expect(manager.getRecentModels()).toEqual([{ provider: "p", id: "m" }]);
	});

	it("persists global history through the Step TOML decorator without altering other configuration", async () => {
		directory = mkdtempSync(join(tmpdir(), "recent-models-"));
		const paths = { global: join(directory, "global.toml"), project: join(directory, "project.toml") };
		const original = {
			defaultProvider: "startup",
			defaultModel: "default",
			mcp_servers: { local: { command: "local-server" } },
			permissionPreset: "ask",
		};
		writeStepConfig(paths.global, original);
		writeStepConfig(paths.project, { recentModels: [{ provider: "project", id: "ignored" }] });
		const first = createStepSettingsManager(directory, undefined, { paths });
		const second = createStepSettingsManager(directory, undefined, { paths });
		first.recordRecentModel("provider", "first");
		await first.flush();
		second.recordRecentModel("provider", "second");
		second.setTheme("dark");
		await second.flush();
		const restarted = createStepSettingsManager(directory, undefined, { paths });
		expect(restarted.getRecentModels()).toEqual([
			{ provider: "provider", id: "second" },
			{ provider: "provider", id: "first" },
		]);
		expect(readStepConfig(paths.global)).toMatchObject(original);
		expect(readStepConfig(paths.project)).toEqual({ recentModels: [{ provider: "project", id: "ignored" }] });
		expect([...first.drainErrors(), ...second.drainErrors(), ...restarted.drainErrors()]).toEqual([]);
	});

	it("keeps external active-model defaults separate from wrapped global history", async () => {
		directory = mkdtempSync(join(tmpdir(), "recent-models-"));
		const path = join(directory, "external.json");
		writeFileSync(
			path,
			JSON.stringify({
				activeModel: "alpha",
				providers: {
					custom: {
						api: "openai-completions",
						baseUrl: "https://example.invalid/v1",
						models: [{ id: "alpha" }, { id: "beta" }],
					},
				},
			}),
		);
		const config = await loadStepCodeConfig({ STEPCODE_CONFIG_PATH: path });
		const paths = { global: join(directory, "global.toml"), project: join(directory, "project.toml") };
		const manager = decorateStepCodeSettingsManager(
			createStepSettingsManager(directory, undefined, { paths }),
			config!,
		);
		manager.recordRecentModel("custom", "alpha");
		manager.setDefaultModelAndProvider("custom", "beta");
		manager.recordRecentModel("custom", "beta");
		await manager.flush();
		expect(manager.getDefaultModel()).toBe("beta");
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ activeModel: "beta" });
		expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("recentModels");
		expect(createStepSettingsManager(directory, undefined, { paths }).getRecentModels()).toEqual([
			{ provider: "custom", id: "beta" },
			{ provider: "custom", id: "alpha" },
		]);
		expect(manager.drainErrors()).toEqual([]);
	});
});
