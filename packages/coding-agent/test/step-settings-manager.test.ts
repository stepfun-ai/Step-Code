import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
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

	it("creates the default Step sidecar paths through the factory", () => {
		const fixture = makeRoot();
		const manager = createStepSettingsManager(fixture.projectDir, fixture.agentDir);

		expect(manager.getStepSettingsPaths()).toEqual({
			global: join(fixture.agentDir, "step-settings.json"),
			project: join(fixture.projectDir, ".step-cli", "step-settings.json"),
		});
	});
});
