import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	readGlobalStepDefaults,
	readStepConfig,
	StepTomlSettingsStorage,
	writeStepConfig,
} from "../src/step/config-toml.ts";
import {
	createStepSettingsManager,
	decorateStepSettingsManager,
	type StepSettingsManager,
} from "../src/step/settings-manager.ts";

describe("Step settings manager decorator", () => {
	const roots: string[] = [];

	function makeRoot(): {
		root: string;
		agentDir: string;
		projectDir: string;
		paths: { global: string; project: string };
	} {
		const root = join(process.cwd(), `test-step-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const paths = {
			global: join(root, "step-settings-global.json"),
			project: join(root, "step-settings-project.json"),
		};
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		roots.push(root);
		return { root, agentDir, projectDir, paths };
	}

	function makeManager(
		fixture = makeRoot(),
		projectTrusted = true,
	): { manager: StepSettingsManager; base: SettingsManager; fixture: ReturnType<typeof makeRoot> } {
		const base = SettingsManager.create(fixture.projectDir, fixture.agentDir, { projectTrusted });
		const manager = decorateStepSettingsManager(base, {
			cwd: fixture.projectDir,
			agentDir: fixture.agentDir,
			paths: fixture.paths,
		});
		return { manager, base, fixture };
	}

	afterEach(() => {
		for (const root of roots.splice(0)) {
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		}
	});

	it("forwards the native Pi API without changing Pi settings", async () => {
		const { manager, base, fixture } = makeManager();

		expect(manager.getPiSettingsManager()).toBe(base);
		expect(manager.getStepSettings()).toEqual({});
		manager.setTheme("step");
		await manager.flush();

		expect(manager.getTheme()).toBe("step");
		expect(JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf8"))).toEqual({ theme: "step" });
		expect(existsSync(fixture.paths.global)).toBe(false);
	});

	it("keeps Step permission policy layered independently from Pi settings", async () => {
		const { manager, fixture } = makeManager();

		manager.setStepSettings({ permissionPreset: "ask", autoResume: false });
		manager.setProjectStepSettings({ permissionPreset: "autopilot" });
		await manager.flush();

		expect(manager.getStepGlobalSettings()).toEqual({ permissionPreset: "ask", autoResume: false });
		expect(manager.getStepProjectSettings()).toEqual({ permissionPreset: "autopilot" });
		expect(manager.getStepSettings()).toEqual({ permissionPreset: "autopilot", autoResume: false });
		expect(JSON.parse(readFileSync(fixture.paths.global, "utf8"))).toEqual({
			permissionPreset: "ask",
			autoResume: false,
		});
		expect(JSON.parse(readFileSync(fixture.paths.project, "utf8"))).toEqual({ permissionPreset: "autopilot" });
		expect(existsSync(join(fixture.projectDir, ".pi", "step-settings.json"))).toBe(false);
	});

	it("writes effective fields back to the scope currently overriding them", () => {
		const { manager, fixture } = makeManager();
		manager.setStepSettings({ permissionPreset: "ask", autoResume: false });
		manager.setProjectStepSettings({ permissionPreset: "bypass" });

		manager.setEffectiveStepSettings({ permissionPreset: "autopilot", autoResume: true });

		expect(JSON.parse(readFileSync(fixture.paths.global, "utf8"))).toEqual({
			permissionPreset: "ask",
			autoResume: true,
		});
		expect(JSON.parse(readFileSync(fixture.paths.project, "utf8"))).toEqual({
			permissionPreset: "autopilot",
		});
	});

	it("honors project trust for the Step sidecar just like Pi", () => {
		const fixture = makeRoot();
		writeFileSync(fixture.paths.project, JSON.stringify({ permissionPreset: "autopilot" }));
		const { manager } = makeManager(fixture, false);

		expect(manager.getStepProjectSettings()).toEqual({});
		expect(manager.getStepPermissionPreset()).toBeUndefined();
		expect(() => manager.setProjectStepSettings({ permissionPreset: "ask" })).toThrow(
			"Project is not trusted; refusing to write project settings",
		);

		manager.setProjectTrusted(true);
		expect(manager.getStepPermissionPreset()).toBe("autopilot");
	});

	it("normalizes legacy aliases and supports clearing a persisted field", () => {
		const fixture = makeRoot();
		writeFileSync(
			fixture.paths.global,
			JSON.stringify({ permissionMode: "auto", autopilot: true, noninteractiveApproval: "allow" }),
		);
		const { manager } = makeManager(fixture);

		expect(manager.getStepSettings()).toEqual({
			permissionPreset: "bypass",
			autoResume: true,
			nonInteractiveApproval: "allow",
		});
		manager.setStepAutoResume(undefined);
		const persisted = JSON.parse(readFileSync(fixture.paths.global, "utf8"));
		expect(persisted.autopilot).toBeUndefined();
		expect(manager.getStepAutoResume()).toBeUndefined();
	});

	it("reads and clears the feedback setting through the Step sidecar", () => {
		const fixture = makeRoot();
		writeFileSync(fixture.paths.global, JSON.stringify({ feedback: { enabled: false } }));
		const { manager } = makeManager(fixture);

		expect(manager.getStepSettings()).toEqual({ feedbackEnabled: false });
		manager.setStepSettings({ feedbackEnabled: true });
		expect(manager.getStepSettings()).toEqual({ feedbackEnabled: true });
		expect(JSON.parse(readFileSync(fixture.paths.global, "utf8"))).toEqual({ feedbackEnabled: true });

		manager.setStepSettings({ feedbackEnabled: undefined });
		expect(manager.getStepSettings()).toEqual({});
		expect(JSON.parse(readFileSync(fixture.paths.global, "utf8"))).toEqual({});
	});

	it("lets a project feedback alias override the global canonical setting", () => {
		const fixture = makeRoot();
		writeFileSync(fixture.paths.global, JSON.stringify({ feedbackEnabled: true }));
		writeFileSync(fixture.paths.project, JSON.stringify({ feedback: { enabled: false } }));
		const { manager } = makeManager(fixture);

		expect(manager.getStepGlobalSettings()).toEqual({ feedbackEnabled: true });
		expect(manager.getStepProjectSettings()).toEqual({ feedbackEnabled: false });
		expect(manager.getStepSettings()).toEqual({ feedbackEnabled: false });
	});

	it("does not resurrect nested legacy approval values after clearing", () => {
		const fixture = makeRoot();
		writeFileSync(
			fixture.paths.global,
			JSON.stringify({
				approval: { preset: "autopilot", mode: "auto", nonInteractive: "allow", autoResume: true },
			}),
		);
		const { manager } = makeManager(fixture);

		expect(manager.getStepSettings()).toEqual({
			permissionPreset: "autopilot",
			approvalMode: "auto",
			nonInteractiveApproval: "allow",
			autoResume: true,
		});
		manager.setStepSettings({
			permissionPreset: undefined,
			approvalMode: undefined,
			nonInteractiveApproval: undefined,
			autoResume: undefined,
		});

		expect(manager.getStepSettings()).toEqual({});
		expect(JSON.parse(readFileSync(fixture.paths.global, "utf8"))).toEqual({});
	});

	it("falls back to a valid legacy alias when a canonical value is invalid", () => {
		const fixture = makeRoot();
		writeFileSync(
			fixture.paths.global,
			JSON.stringify({
				permissionPreset: "unknown",
				permissionMode: "read-only",
				approvalMode: "unknown",
				approval: { mode: "strict" },
			}),
		);
		const { manager } = makeManager(fixture);

		expect(manager.getStepSettings()).toEqual({
			permissionPreset: "read-only",
			approvalMode: "strict",
		});
	});

	it("deep-merges legacy approval objects across global and project scopes", () => {
		const fixture = makeRoot();
		writeFileSync(fixture.paths.global, JSON.stringify({ approval: { mode: "auto", autoResume: true } }));
		writeFileSync(fixture.paths.project, JSON.stringify({ approval: { nonInteractive: "allow" } }));
		const { manager } = makeManager(fixture);

		expect(manager.getStepSettings()).toEqual({
			approvalMode: "auto",
			nonInteractiveApproval: "allow",
			autoResume: true,
		});
	});

	it("writes effective updates to a project scope selected through a nested legacy alias", () => {
		const fixture = makeRoot();
		writeFileSync(fixture.paths.project, JSON.stringify({ tools: { approval: { mode: "strict" } } }));
		const { manager } = makeManager(fixture);

		manager.setEffectiveStepSettings({ approvalMode: "auto" });

		expect(existsSync(fixture.paths.global)).toBe(false);
		expect(JSON.parse(readFileSync(fixture.paths.project, "utf8"))).toEqual({ approvalMode: "auto" });
	});

	it("does not lose updates from separate manager instances", () => {
		const fixture = makeRoot();
		const first = makeManager(fixture).manager;
		const second = makeManager(fixture).manager;

		first.setStepPermissionPreset("ask");
		second.setStepAutoResume(true);

		expect(JSON.parse(readFileSync(fixture.paths.global, "utf8"))).toEqual({
			permissionPreset: "ask",
			autoResume: true,
		});
	});

	it("reports malformed sidecar files without overwriting them", () => {
		const fixture = makeRoot();
		writeFileSync(fixture.paths.global, "{broken");
		const { manager } = makeManager(fixture);

		expect(manager.getStepSettings()).toEqual({});
		expect(manager.drainErrors()).toMatchObject([{ scope: "global", path: fixture.paths.global }]);
		expect(readFileSync(fixture.paths.global, "utf8")).toBe("{broken");
	});

	it("treats missing project TOML as empty on load, reload and trust changes", async () => {
		const fixture = makeRoot();
		fixture.paths.global = join(fixture.root, "config.toml");
		fixture.paths.project = join(fixture.projectDir, ".stepcode", "config.toml");
		writeFileSync(fixture.paths.global, 'permissionPreset = "ask"\n');
		const { manager } = makeManager(fixture);

		expect(manager.getStepSettings()).toEqual({ permissionPreset: "ask" });
		expect(manager.drainErrors()).toEqual([]);
		await manager.reload();
		manager.setProjectTrusted(false);
		manager.setProjectTrusted(true);
		expect(manager.getStepProjectSettings()).toEqual({});
		expect(manager.drainErrors()).toEqual([]);
		expect(existsSync(fixture.paths.project)).toBe(false);
		expect(existsSync(join(fixture.projectDir, ".stepcode"))).toBe(false);

		manager.setProjectStepSettings({ permissionPreset: "read-only" });
		expect(manager.drainErrors()).toEqual([]);
		expect(readStepConfig(fixture.paths.project)).toEqual({ permissionPreset: "read-only" });
		await manager.reload();
		expect(manager.getStepSettings()).toEqual({ permissionPreset: "read-only" });
		expect(manager.drainErrors()).toEqual([]);
	});

	it("continues reporting malformed project TOML without overwriting it", () => {
		const fixture = makeRoot();
		fixture.paths.project = join(fixture.projectDir, "config.toml");
		writeFileSync(fixture.paths.project, "permissionPreset = [");
		const { manager } = makeManager(fixture);
		expect(manager.drainErrors()).toMatchObject([{ scope: "project", path: fixture.paths.project }]);
		manager.setProjectStepSettings({ permissionPreset: "ask" });
		expect(manager.drainErrors()).toMatchObject([{ scope: "project", path: fixture.paths.project }]);
		expect(readFileSync(fixture.paths.project, "utf8")).toBe("permissionPreset = [");
	});

	it("reports project TOML read errors other than ENOENT", () => {
		const fixture = makeRoot();
		fixture.paths.project = join(fixture.projectDir, "config.toml");
		mkdirSync(fixture.paths.project);
		const { manager } = makeManager(fixture);
		expect(manager.drainErrors()).toMatchObject([{ scope: "project", path: fixture.paths.project }]);
	});

	it("uses unified TOML paths through the factory", () => {
		const fixture = makeRoot();
		const manager = createStepSettingsManager(fixture.projectDir, fixture.agentDir);

		expect(manager.getStepSettingsPaths()).toEqual({
			global: resolve(fixture.agentDir, "..", "config.toml"),
			project: join(fixture.projectDir, ".stepcode", "config.toml"),
		});
	});

	it("keeps the header comment and the MCP table across a settings write", () => {
		const fixture = makeRoot();
		const path = join(fixture.root, "config.toml");
		writeFileSync(
			path,
			[
				"# StepCode configuration",
				"# hand written note",
				"",
				'defaultModel = "keep"',
				"",
				"[mcp_servers.demo]",
				'command = "demo"',
				"",
			].join("\n"),
		);
		const storage = new StepTomlSettingsStorage(fixture.projectDir, process.env, { global: path, project: path });

		storage.withLock("global", (current) => {
			expect(JSON.parse(current ?? "{}")).toEqual({ defaultModel: "keep" });
			return JSON.stringify({ defaultModel: "next" });
		});

		const written = readFileSync(path, "utf8");
		expect(written.startsWith("# StepCode configuration\n# hand written note\n")).toBe(true);
		expect(readStepConfig(path)).toEqual({ defaultModel: "next", mcp_servers: { demo: { command: "demo" } } });
	});

	it("drops cleared values instead of reshaping the document", () => {
		const fixture = makeRoot();
		const path = join(fixture.root, "config.toml");
		writeStepConfig(path, { defaultModel: "keep", cleared: null, nested: { keep: 1, gone: null } } as never);

		expect(readStepConfig(path)).toEqual({ defaultModel: "keep", nested: { keep: 1 } });
	});
});

describe("Step global defaults", () => {
	const roots: string[] = [];

	function makeConfigRoot(): { env: NodeJS.ProcessEnv; configRoot: string } {
		const root = join(process.cwd(), `test-step-defaults-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		const configRoot = join(root, ".stepcode");
		mkdirSync(configRoot, { recursive: true });
		roots.push(root);
		return { env: { HOME: root, STEP_CODING_AGENT_DIR: join(configRoot, "agent") }, configRoot };
	}

	afterEach(() => {
		for (const root of roots.splice(0)) {
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads the persisted provider, model and telemetry from the unified config", () => {
		const { env, configRoot } = makeConfigRoot();
		writeFileSync(
			join(configRoot, "config.toml"),
			['defaultProvider = "acme"', 'defaultModel = "acme-1"', "[telemetry]", "enabled = false", ""].join("\n"),
		);

		expect(readGlobalStepDefaults(env)).toEqual({
			provider: "acme",
			model: "acme-1",
			// A saved opt-out has to survive: the telemetry runtime is built from
			// this value before Pi's settings manager exists.
			telemetry: { enabled: false },
		});
	});

	it("returns no defaults when the config is missing or malformed", () => {
		const { env, configRoot } = makeConfigRoot();
		expect(readGlobalStepDefaults(env)).toEqual({});

		writeFileSync(join(configRoot, "config.toml"), "defaultProvider = \n");
		expect(readGlobalStepDefaults(env)).toEqual({});
	});

	it("resolves the global config beside an injected agent directory", () => {
		const { env, configRoot } = makeConfigRoot();
		// `step mcp add`, MCP discovery and the settings manager must address one
		// file even when a host points the agent directory somewhere unusual.
		env.STEP_CODING_AGENT_DIR = join(configRoot, "nested", "agent");
		mkdirSync(join(configRoot, "nested"), { recursive: true });
		writeFileSync(join(configRoot, "nested", "config.toml"), 'defaultModel = "nested"\n');

		expect(readGlobalStepDefaults(env)).toEqual({ model: "nested" });
	});
});
