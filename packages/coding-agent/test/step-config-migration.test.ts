import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createStepProviderConfig, STEP_PROVIDER_ID } from "../src/extensions/step-provider/index.ts";
import { migrateStepConfig, readStepGlobalDefaults } from "../src/step/config-migration.ts";

type FetchInput = Parameters<typeof fetch>[0];

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeHome(): Promise<{ home: string; workspace: string }> {
	const root = await mkdtemp(join(tmpdir(), "step-config-migration-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	await writeFile(join(root, ".keep"), "");
	await mkdir(workspace, { recursive: true });
	return { home: root, workspace };
}

describe("Step config migration", () => {
	test("projects legacy model config into Pi settings/models/auth", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: {
					model: "glm-5",
					provider: "step",
					api: "openai-chat-completions",
					baseUrl: "https://example.test/v1",
					apiKey: "secret-value",
					maxContextTokens: 128000,
					maxOutputTokens: 8192,
				},
				models: [{ id: "fast", model: "fast-model", default: true }],
				tools: { approval: { mode: "auto" } },
			}),
		);
		await writeFile(
			join(legacy, "auth.json"),
			JSON.stringify({
				version: 1,
				profile: "step_plan",
				apiKey: "secret-value",
				uid: "account-42",
			}),
		);

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(report.migrated).toBe(true);
		const target = join(home, ".step-cli");
		const settings = JSON.parse(await readFile(join(target, "agent", "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		const models = JSON.parse(await readFile(join(target, "agent", "models.json"), "utf8")) as {
			providers: Record<string, { api?: string; models?: Array<Record<string, unknown>> }>;
		};
		const provider = models.providers.step;
		expect(settings.defaultProvider).toBe("step");
		expect(settings.defaultModel).toBe("glm-5");
		expect(provider.api).toBe("openai-completions");
		expect(provider.models?.map((model) => model.id)).toEqual(["fast-model", "glm-5"]);
		expect(JSON.stringify(settings)).not.toContain("secret-value");
		const auth = JSON.parse(await readFile(join(target, "agent", "auth.json"), "utf8")) as Record<
			string,
			{ type?: string; access?: string; refresh?: string; expires?: number; uid?: string }
		>;
		expect(auth.step).toMatchObject({
			type: "oauth",
			access: "secret-value",
			refresh: "step-static-credential",
			expires: Number.MAX_SAFE_INTEGER,
			uid: "account-42",
		});
		expect((await readStepGlobalDefaults(join(target, "agent"))).model).toBe("glm-5");
		expect(report.warnings.some((warning) => warning.includes("tools"))).toBe(true);
	});

	test("preserves a model-level credential reference on the emitted provider", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: { model: "wire-model", provider: "custom" },
				providers: {
					custom: {
						api: "openai-chat-completions",
						baseUrl: "https://custom.example/v1",
						models: [{ id: "profile", model: "wire-model", apiKey: "$CUSTOM_API_KEY" }],
					},
				},
			}),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const agentDir = join(home, ".step-cli", "agent");
		const models = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as {
			providers: Record<string, { apiKey?: string }>;
		};

		expect(models.providers.custom?.apiKey).toBe("$CUSTOM_API_KEY");
		await expect(stat(join(agentDir, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("does not migrate legacy approval policy into the Step settings sidecar", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: { model: "step-model", provider: "step" },
				tools: { approval: { mode: "auto", nonInteractive: "allow", autoResume: true } },
			}),
		);

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(report.migrated).toBe(true);
		await expect(stat(join(home, ".step-cli", "agent", "step-settings.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	test("does not create a target directory for an approval-only legacy config", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(join(legacy, "config.json"), JSON.stringify({ tools: { approval: { mode: "auto" } } }));

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(report.migrated).toBe(false);
		await expect(stat(join(home, ".step-cli", "agent", "settings.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	test("retries legacy v1 markers and upgrades the projection", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		const target = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await mkdir(target, { recursive: true });
		await writeFile(join(target, ".legacy-step-cli-migration.json"), JSON.stringify({ version: 1 }));
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: { model: "retry-model", provider: "step" },
				tools: { approval: { mode: "strict", nonInteractive: "deny", autoResume: false } },
			}),
		);

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const settings = JSON.parse(await readFile(join(target, "agent", "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		const marker = JSON.parse(await readFile(join(target, ".legacy-step-cli-migration.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(report.migrated).toBe(true);
		expect(settings.defaultModel).toBe("retry-model");
		expect(marker.version).toBeGreaterThan(1);
	});

	test("imports a legacy login that appears after the model migration marker", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		const target = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({ model: { model: "late-model", provider: "step" } }),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		await writeFile(
			join(legacy, "auth.json"),
			JSON.stringify({ version: 1, profile: "step_plan", apiKey: "late-login", uid: "late-user" }),
		);

		const second = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(second.migrated).toBe(true);
		const auth = JSON.parse(await readFile(join(target, "agent", "auth.json"), "utf8")) as Record<
			string,
			Record<string, unknown>
		>;
		expect(auth.step).toMatchObject({ type: "oauth", access: "late-login", uid: "late-user" });
	});

	test("uses an injected HOME when no explicit homeDir is provided", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({ model: { model: "env-home-model", provider: "step" } }),
		);

		const report = await migrateStepConfig({ cwd: workspace, env: { HOME: home } });

		expect(report.migrated).toBe(true);
		expect(await readFile(join(home, ".step-cli", "agent", "settings.json"), "utf8")).toContain("env-home-model");
	});

	test("keeps project configuration separate and does not overwrite an existing target", async () => {
		const { home, workspace } = await makeHome();
		const legacyProject = join(workspace, ".step-cli");
		await mkdir(legacyProject, { recursive: true });
		await writeFile(
			join(legacyProject, "config.json"),
			JSON.stringify({ model: { model: "workspace-model", provider: "step" } }),
		);
		const first = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(first.migrated).toBe(true);
		const target = join(workspace, ".step-cli");
		const before = await readFile(join(target, "settings.json"), "utf8");
		await writeFile(join(target, "settings.json"), `${before.trim()}\nchanged\n`);
		const second = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(second.roots.find((root) => root.scope === "project")?.migrated).toBe(false);
		expect(await readFile(join(target, "settings.json"), "utf8")).toContain("changed");
	});

	test("re-runs a version-one marker to complete newer catalog migration", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		const target = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await mkdir(join(target, "agent"), { recursive: true });
		await writeFile(join(target, ".legacy-step-cli-migration.json"), JSON.stringify({ version: 1 }));
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: {
					provider: "step",
					model: "new-wire",
					api: "openai-chat-completions",
					baseUrl: "https://example.test/v1",
				},
			}),
		);

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const models = JSON.parse(await readFile(join(target, "agent", "models.json"), "utf8")) as {
			providers?: Record<string, { models?: Array<{ id?: string }> }>;
		};
		expect(report.roots.find((root) => root.scope === "global")?.migrated).toBe(true);
		expect(models.providers?.step?.models).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "new-wire" })]),
		);
	});

	test("does not import legacy runtime/session directories", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(join(legacy, "sessions"), { recursive: true });
		await writeFile(join(legacy, "sessions", "old.jsonl"), "legacy session");
		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(report.migrated).toBe(false);
		await expect(stat(join(home, ".step-cli", "agent", "settings.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	test("reports malformed legacy config and continues", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(join(legacy, "config.json"), "{broken");
		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(report.warnings.join("\n")).toContain("Could not parse legacy config");
		expect(report.migrated).toBe(false);
	});

	test("does not treat Pi directories as a migration source", async () => {
		const { home, workspace } = await makeHome();
		const piGlobal = join(home, ".pi", "agent");
		const piProject = join(workspace, ".pi");
		await mkdir(piGlobal, { recursive: true });
		await mkdir(piProject, { recursive: true });
		await writeFile(join(piGlobal, "settings.json"), JSON.stringify({ defaultModel: "pi-global" }));
		await writeFile(join(piProject, "settings.json"), JSON.stringify({ defaultModel: "pi-project" }));

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });

		expect(report.migrated).toBe(false);
		await expect(stat(join(home, ".step-cli"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(join(workspace, ".step-cli"))).rejects.toMatchObject({ code: "ENOENT" });
		// The decoy files are not consumed or rewritten as a side effect.
		expect(JSON.parse(await readFile(join(piGlobal, "settings.json"), "utf8"))).toEqual({
			defaultModel: "pi-global",
		});
		expect(JSON.parse(await readFile(join(piProject, "settings.json"), "utf8"))).toEqual({
			defaultModel: "pi-project",
		});
	});

	test("repairs an existing pre-marker Step login binding", async () => {
		const { home, workspace } = await makeHome();
		const agent = join(home, ".step-cli", "agent");
		await mkdir(agent, { recursive: true });
		await writeFile(
			join(agent, "settings.json"),
			JSON.stringify({ defaultProvider: "models-proxy", defaultModel: "step-3.7-flash" }),
		);
		await writeFile(
			join(agent, "auth.json"),
			JSON.stringify({
				step: {
					type: "oauth",
					access: "step-access",
					refresh: "step-static-credential",
					expires: Number.MAX_SAFE_INTEGER,
				},
			}),
		);
		await writeFile(
			join(agent, "models.json"),
			JSON.stringify({
				providers: {
					"models-proxy": { baseUrl: "https://models-proxy.example" },
					step: {
						api: "openai-completions",
						baseUrl: "https://api.stepfun.com/step_plan/v1",
						models: [
							{
								id: "step-3.7-flash",
								api: "openai-completions",
								baseUrl: "https://api.stepfun.com/step_plan/v1/messages",
							},
						],
					},
				},
			}),
		);

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const settings = JSON.parse(await readFile(join(agent, "settings.json"), "utf8")) as Record<string, unknown>;
		const models = JSON.parse(await readFile(join(agent, "models.json"), "utf8")) as {
			providers: Record<string, { api?: string; baseUrl?: string; models?: Array<Record<string, unknown>> }>;
		};

		expect(report.migrated).toBe(true);
		expect(settings).toMatchObject({ defaultProvider: STEP_PROVIDER_ID, defaultModel: "step-3.7-flash" });
		expect(models.providers.step).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.stepfun.com/step_plan",
		});
		expect(models.providers.step.models?.[0]).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.stepfun.com/step_plan",
		});
	});

	test("migrates legacy model/auth while leaving ordinary settings and resources behind", async () => {
		const { home, workspace } = await makeHome();
		const legacyGlobal = join(home, ".step-cli");
		const legacyProject = join(workspace, ".step-cli");
		await mkdir(join(legacyGlobal, "agent", "themes"), { recursive: true });
		await mkdir(join(legacyGlobal, "agent", "sessions"), { recursive: true });
		await mkdir(join(legacyProject, "skills"), { recursive: true });
		await writeFile(
			join(legacyGlobal, "config.json"),
			JSON.stringify({
				model: {
					model: "global-model",
					provider: "step",
					apiKey: "global-secret",
				},
			}),
		);
		await writeFile(
			join(legacyProject, "config.json"),
			JSON.stringify({
				model: {
					model: "project-model",
					provider: "step",
					apiKey: "project-secret",
				},
			}),
		);
		// These are intentionally Pi-shaped files/resources, but they are not part
		// of the legacy Step config contract and must not be copied wholesale.
		await writeFile(
			join(legacyGlobal, "agent", "settings.json"),
			JSON.stringify({ defaultModel: "stale-pi-model", customSetting: "must-not-copy" }),
		);
		await writeFile(
			join(legacyGlobal, "agent", "models.json"),
			JSON.stringify({ providers: { stale: { models: [{ id: "stale-model" }] } } }),
		);
		await writeFile(join(legacyGlobal, "agent", "themes", "stale.json"), "{}");
		await writeFile(join(legacyGlobal, "agent", "sessions", "old.jsonl"), "legacy session");
		await writeFile(join(legacyProject, "settings.json"), JSON.stringify({ customSetting: "project-stale" }));
		await writeFile(join(legacyProject, "skills", "stale.md"), "legacy skill");

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(report.migrated).toBe(true);

		const globalTarget = join(home, ".step-cli");
		const projectTarget = join(workspace, ".step-cli");
		const globalSettings = JSON.parse(await readFile(join(globalTarget, "agent", "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		const projectSettings = JSON.parse(await readFile(join(projectTarget, "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(globalSettings.defaultModel).toBe("stale-pi-model");
		expect(projectSettings.defaultModel).toBe("project-model");
		expect(globalSettings.customSetting).toBe("must-not-copy");
		expect(projectSettings.customSetting).toBe("project-stale");

		const globalAuth = JSON.parse(await readFile(join(globalTarget, "agent", "auth.json"), "utf8")) as Record<
			string,
			{ key?: string }
		>;
		expect(globalAuth.step?.key).toBe("global-secret");
		// Pi keeps auth global-only. A project credential is considered only when
		// the global store has no entry for that provider.
		await expect(stat(join(projectTarget, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(report.warnings.some((warning) => warning.includes("workspace model definitions"))).toBe(true);

		expect(await stat(join(globalTarget, "agent", "themes"))).toBeDefined();
		expect(await stat(join(globalTarget, "agent", "sessions"))).toBeDefined();
		expect(await stat(join(projectTarget, "skills"))).toBeDefined();
		const migratedModels = JSON.parse(await readFile(join(globalTarget, "agent", "models.json"), "utf8")) as {
			providers?: Record<string, { models?: Array<{ id?: string }> }>;
		};
		expect(migratedModels.providers?.stale).toBeDefined();
		expect(migratedModels.providers?.step?.models?.map((model) => model.id)).toContain("global-model");
	});

	test("migrates agent-scoped legacy auth even when no config file exists", async () => {
		const { home, workspace } = await makeHome();
		const legacyGlobalAgent = join(home, ".step-cli", "agent");
		const legacyProject = join(workspace, ".step-cli");
		await mkdir(legacyGlobalAgent, { recursive: true });
		await mkdir(legacyProject, { recursive: true });
		await writeFile(join(legacyGlobalAgent, "auth.json"), JSON.stringify({ apiKey: "global-agent-secret" }));
		await writeFile(join(legacyProject, "auth.json"), JSON.stringify({ apiKey: "project-secret" }));

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(report.migrated).toBe(true);

		const globalAuth = JSON.parse(await readFile(join(home, ".step-cli", "agent", "auth.json"), "utf8")) as Record<
			string,
			{ key?: string }
		>;
		expect(globalAuth.step?.key).toBe("global-agent-secret");
		expect(await stat(join(workspace, ".step-cli", "auth.json"))).toBeDefined();
	});

	test("uses the legacy model field as the Pi wire id while retaining profile aliases", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: { model: "wire-default", provider: "step" },
				activeModel: "fast",
				models: [{ id: "fast", model: "wire-fast", default: true }],
			}),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const target = join(home, ".step-cli", "agent");
		const settings = JSON.parse(await readFile(join(target, "settings.json"), "utf8")) as Record<string, unknown>;
		const models = JSON.parse(await readFile(join(target, "models.json"), "utf8")) as {
			providers: Record<string, { models?: Array<Record<string, unknown>> }>;
		};
		const entries = models.providers.step?.models ?? [];
		expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: "wire-fast", name: "fast" })]));
		expect(entries.some((entry) => "model" in entry)).toBe(false);
		expect(settings.defaultModel).toBe("wire-fast");
	});

	test("preserves provider model aliases and normalizes legacy operation endpoints", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				activeModel: "opus",
				providers: {
					"models-proxy": {
						baseUrl: "https://proxy.example/v1/messages",
						api: "anthropic-messages",
						models: [
							{ id: "opus", model: "claude-opus-5" },
							{ id: "sonnet", model: "claude-sonnet-5" },
						],
					},
				},
			}),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const target = join(home, ".step-cli", "agent");
		const settings = JSON.parse(await readFile(join(target, "settings.json"), "utf8")) as Record<string, unknown>;
		const models = JSON.parse(await readFile(join(target, "models.json"), "utf8")) as {
			providers: Record<
				string,
				{ baseUrl?: string; models?: Array<{ id?: string; name?: string; baseUrl?: string }> }
			>;
		};
		const provider = models.providers["models-proxy"];
		expect(settings).toMatchObject({ defaultProvider: "models-proxy", defaultModel: "claude-opus-5" });
		expect(provider.baseUrl).toBe("https://proxy.example");
		expect(provider.models?.map((model) => model.id)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
		expect(provider.models?.every((model) => model.baseUrl === "https://proxy.example")).toBe(true);
	});

	test("normalizes duplicated Anthropic version and operation suffixes during legacy projection", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: {
					model: "step-3.7-flash",
					provider: "step",
					api: "anthropic-messages",
					baseUrl: "https://api.stepfun.com/step_plan/v1/v1/messages",
				},
			}),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const models = JSON.parse(await readFile(join(home, ".step-cli", "agent", "models.json"), "utf8")) as {
			providers: Record<string, { baseUrl?: string; models?: Array<{ baseUrl?: string }> }>;
		};
		const provider = models.providers.step;
		expect(provider.baseUrl).toBe("https://api.stepfun.com/step_plan");
		expect(provider.models?.[0]?.baseUrl).toBe("https://api.stepfun.com/step_plan");
	});

	test("resolves a provider-specific models-proxy API dialect", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: {
					model: "step-model",
					provider: "stepfunModelProxy",
				},
				integrations: {
					modelsProxy: {
						baseUrl: "https://proxy.example/v1",
						api: { stepfunModelProxy: "anthropic-messages", neocodex: "openai-compatible" },
					},
				},
			}),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const models = JSON.parse(await readFile(join(home, ".step-cli", "agent", "models.json"), "utf8")) as {
			providers: Record<string, { api?: string }>;
		};
		expect(models.providers.stepfunModelProxy?.api).toBe("anthropic-messages");
	});

	test("ModelRuntime can resolve a migrated Step OAuth credential and custom wire model", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: {
					model: "wire-model",
					provider: "step",
					api: "openai-chat-completions",
					baseUrl: "https://legacy.example/v1",
				},
			}),
		);
		await writeFile(
			join(legacy, "auth.json"),
			JSON.stringify({ version: 1, profile: "step_plan", apiKey: "legacy-key", uid: "uid-7" }),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const agentDir = join(home, ".step-cli", "agent");
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		runtime.registerProvider(STEP_PROVIDER_ID, createStepProviderConfig({ apiBaseUrl: "https://step.example/v1" }));

		const model = runtime.getModel(STEP_PROVIDER_ID, "wire-model");
		expect(model).toMatchObject({
			id: "wire-model",
			api: "openai-completions",
			baseUrl: "https://legacy.example/v1",
		});
		expect(model).toBeDefined();
		const auth = await runtime.getAuth(model!);
		expect(auth?.auth.apiKey).toBe("legacy-key");
		expect(await runtime.checkAuth(STEP_PROVIDER_ID)).toMatchObject({ type: "oauth" });
		expect(await AuthStorage.create(join(agentDir, "auth.json")).read(STEP_PROVIDER_ID)).toMatchObject({
			type: "oauth",
			access: "legacy-key",
			uid: "uid-7",
		});
	});

	test("projects a legacy Anthropic wire provider onto Step when the login owns the key", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: {
					model: "step-3.7-flash",
					provider: "anthropic",
					api: "anthropic-messages",
					baseUrl: "https://api.stepfun.com/step_plan/v1",
				},
			}),
		);
		await writeFile(
			join(legacy, "auth.json"),
			JSON.stringify({ version: 1, profile: "step_plan", apiKey: "legacy-plan-key" }),
		);

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const agentDir = join(home, ".step-cli", "agent");
		const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const models = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as {
			providers: Record<string, { models?: Array<Record<string, unknown>> }>;
		};
		expect(report.defaultProvider).toBe(STEP_PROVIDER_ID);
		expect(settings.defaultProvider).toBe(STEP_PROVIDER_ID);
		expect(models.providers.anthropic).toBeUndefined();
		expect(models.providers.step?.models).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "step-3.7-flash" })]),
		);

		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		runtime.registerProvider(
			STEP_PROVIDER_ID,
			createStepProviderConfig({ apiBaseUrl: "https://api.stepfun.com/step_plan/v1" }),
		);
		const model = runtime.getModel(STEP_PROVIDER_ID, "step-3.7-flash");
		expect((await runtime.getAuth(model!))?.auth.apiKey).toBe("legacy-plan-key");
	});

	test("repairs stale Step endpoint overrides from an earlier Harness release", async () => {
		const { home, workspace } = await makeHome();
		const agentDir = join(home, ".step-cli", "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					step: {
						api: "anthropic-messages",
						baseUrl: "https://api.stepfun.com/step_plan/v1",
						models: [
							{
								id: "step-3.7-flash",
								api: "anthropic-messages",
								baseUrl: "https://api.stepfun.com/step_plan/v1/messages",
							},
						],
					},
					custom: {
						api: "openai-completions",
						baseUrl: "https://custom.example/v1",
					},
				},
			}),
		);
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({
				step: {
					type: "oauth",
					access: "stored-step-key",
					refresh: "step-static-credential",
					expires: Number.MAX_SAFE_INTEGER,
				},
			}),
		);

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const models = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as {
			providers: Record<string, { baseUrl?: string; models?: Array<{ baseUrl?: string }> }>;
		};
		expect(report.migrated).toBe(true);
		expect(models.providers.step?.baseUrl).toBe("https://api.stepfun.com/step_plan");
		expect(models.providers.step?.models?.[0]?.baseUrl).toBe("https://api.stepfun.com/step_plan");
		expect(models.providers.custom?.baseUrl).toBe("https://custom.example/v1");

		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		runtime.registerProvider(STEP_PROVIDER_ID, createStepProviderConfig());
		const model = runtime.getModel(STEP_PROVIDER_ID, "step-3.7-flash");
		expect(model?.baseUrl).toBe("https://api.stepfun.com/step_plan");

		let requestUrl: string | undefined;
		await runtime.completeSimple(
			model!,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				fetch: async (input) => {
					requestUrl = String(input);
					return new Response(null, { status: 404 });
				},
			},
		);
		expect(requestUrl).toBe("https://api.stepfun.com/step_plan/v1/messages");
	});

	test("rebinds a legacy proxy default when the Step login arrives after migration", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: {
					model: "step-3.7-flash",
					provider: "models-proxy",
					api: "anthropic-messages",
					baseUrl: "https://models-proxy.example/v1/messages",
				},
			}),
		);

		const first = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(first.defaultProvider).toBe("models-proxy");
		const agentDir = join(home, ".step-cli", "agent");
		await writeFile(
			join(legacy, "auth.json"),
			JSON.stringify({ version: 1, profile: "step_plan", apiKey: "late-step-key" }),
		);

		const second = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect(second.migrated).toBe(true);
		expect(settings.defaultProvider).toBe(STEP_PROVIDER_ID);

		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		runtime.registerProvider(STEP_PROVIDER_ID, createStepProviderConfig());
		const model = runtime.getModel(STEP_PROVIDER_ID, "step-3.7-flash");
		expect(model?.baseUrl).toBe("https://api.stepfun.com/step_plan");
		let requestUrl: string | undefined;
		await runtime.completeSimple(
			model!,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				fetch: async (input) => {
					requestUrl = String(input);
					return new Response(null, { status: 404 });
				},
			},
		);
		expect(requestUrl).toBe("https://api.stepfun.com/step_plan/v1/messages");
	});

	test("rebinds a host-derived api provider when the Step login arrives after migration", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: {
					model: "step-3.7-flash",
					api: "anthropic-messages",
					baseUrl: "https://api.stepfun.com/step_plan/v1",
				},
			}),
		);

		const first = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(first.defaultProvider).toBe("api");
		await writeFile(
			join(legacy, "auth.json"),
			JSON.stringify({ version: 1, profile: "step_plan", apiKey: "late-step-key" }),
		);

		const second = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const agentDir = join(home, ".step-cli", "agent");
		const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect(second.migrated).toBe(true);
		expect(settings.defaultProvider).toBe(STEP_PROVIDER_ID);

		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		runtime.registerProvider(STEP_PROVIDER_ID, createStepProviderConfig());
		const model = runtime.getModel(STEP_PROVIDER_ID, "step-3.7-flash");
		expect(model).toMatchObject({ api: "anthropic-messages", baseUrl: "https://api.stepfun.com/step_plan" });
	});

	test("repairs a migrated built-in Step model that retained the legacy OpenAI dialect", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: {
					model: "step-3.7-flash",
					provider: "models-proxy",
				},
				integrations: {
					modelsProxy: {
						api: "openai-compatible",
						baseUrl: "https://models-proxy.example/v1/messages",
					},
				},
			}),
		);
		await writeFile(
			join(legacy, "auth.json"),
			JSON.stringify({ version: 1, profile: "step_plan", apiKey: "legacy-step-key" }),
		);

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const agentDir = join(home, ".step-cli", "agent");
		const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const models = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as {
			providers: Record<string, { api?: string; baseUrl?: string; models?: Array<Record<string, unknown>> }>;
		};
		const stepProvider = models.providers[STEP_PROVIDER_ID];
		const stepModel = stepProvider?.models?.find((entry) => entry.id === "step-3.7-flash");
		expect(report.defaultProvider).toBe(STEP_PROVIDER_ID);
		expect(settings.defaultProvider).toBe(STEP_PROVIDER_ID);
		expect(stepProvider).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.stepfun.com/step_plan",
		});
		expect(stepModel).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.stepfun.com/step_plan",
		});

		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		runtime.registerProvider(STEP_PROVIDER_ID, createStepProviderConfig({ env: {} }));
		const model = runtime.getModel(STEP_PROVIDER_ID, "step-3.7-flash");
		expect(model).toMatchObject({ api: "anthropic-messages", baseUrl: "https://api.stepfun.com/step_plan" });
		let requestUrl: string | undefined;
		await runtime.completeSimple(
			model!,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				fetch: async (input) => {
					requestUrl = String(input);
					return new Response(null, { status: 401 });
				},
			},
		);
		expect(requestUrl).toBe("https://api.stepfun.com/step_plan/v1/messages");
	});

	test("keeps an explicit legacy provider key ahead of a stored Step login", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: {
					model: "claude-custom",
					provider: "anthropic",
					api: "anthropic-messages",
					baseUrl: "https://anthropic.example/v1",
					apiKey: "explicit-anthropic-key",
				},
			}),
		);
		await writeFile(
			join(legacy, "auth.json"),
			JSON.stringify({ version: 1, profile: "step_plan", apiKey: "legacy-plan-key" }),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const agentDir = join(home, ".step-cli", "agent");
		const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as Record<
			string,
			{ key?: string; access?: string }
		>;
		expect(settings.defaultProvider).toBe("anthropic");
		expect(auth.anthropic?.key).toBe("explicit-anthropic-key");
		expect(auth.step?.access).toBe("legacy-plan-key");
	});

	test("reuses a migrated global Step login for a project Anthropic config", async () => {
		const { home, workspace } = await makeHome();
		const legacyGlobal = join(home, ".step-cli");
		const legacyProject = join(workspace, ".step-cli");
		await mkdir(legacyGlobal, { recursive: true });
		await mkdir(legacyProject, { recursive: true });
		await writeFile(
			join(legacyGlobal, "auth.json"),
			JSON.stringify({ version: 1, profile: "step_plan", apiKey: "global-plan-key" }),
		);
		await writeFile(
			join(legacyProject, "config.json"),
			JSON.stringify({
				model: {
					model: "step-3.7-flash",
					provider: "anthropic",
					api: "anthropic-messages",
					baseUrl: "https://api.stepfun.com/step_plan/v1",
				},
			}),
		);

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const projectSettings = JSON.parse(
			await readFile(join(workspace, ".step-cli", "settings.json"), "utf8"),
		) as Record<string, unknown>;
		expect(report.roots.find((root) => root.scope === "project")?.migrated).toBe(true);
		expect(projectSettings.defaultProvider).toBe(STEP_PROVIDER_ID);
	});

	test("merges project custom models into the global Pi catalog", async () => {
		const { home, workspace } = await makeHome();
		const legacyProject = join(workspace, ".step-cli");
		await mkdir(legacyProject, { recursive: true });
		await writeFile(
			join(legacyProject, "config.json"),
			JSON.stringify({
				activeModel: "workspace-profile",
				model: {
					provider: "models-proxy",
					api: "openai-chat-completions",
					baseUrl: "https://workspace.example/v1",
				},
				models: [{ id: "workspace-profile", model: "workspace-wire", default: true }],
			}),
		);

		const report = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const globalAgentDir = join(home, ".step-cli", "agent");
		const projectSettings = JSON.parse(
			await readFile(join(workspace, ".step-cli", "settings.json"), "utf8"),
		) as Record<string, unknown>;
		const models = JSON.parse(await readFile(join(globalAgentDir, "models.json"), "utf8")) as {
			providers: Record<string, { models?: Array<{ id?: string; name?: string; baseUrl?: string }> }>;
		};
		expect(report.roots.find((root) => root.scope === "project")?.migrated).toBe(true);
		expect(projectSettings).toMatchObject({ defaultProvider: "models-proxy", defaultModel: "workspace-wire" });
		expect(models.providers["models-proxy"]?.models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "workspace-wire",
					name: "workspace-profile",
					baseUrl: "https://workspace.example/v1",
				}),
			]),
		);

		const runtime = await ModelRuntime.create({
			authPath: join(globalAgentDir, "auth.json"),
			modelsPath: join(globalAgentDir, "models.json"),
			refreshOnCreate: false,
		});
		const model = runtime.getModel("models-proxy", "workspace-wire");
		expect(model).toMatchObject({ provider: "models-proxy", api: "openai-completions" });
	});

	test("projects a project custom provider onto Step when the global login owns the key", async () => {
		const { home, workspace } = await makeHome();
		const legacyGlobal = join(home, ".step-cli");
		const legacyProject = join(workspace, ".step-cli");
		await mkdir(legacyGlobal, { recursive: true });
		await mkdir(legacyProject, { recursive: true });
		await writeFile(
			join(legacyGlobal, "auth.json"),
			JSON.stringify({ version: 1, profile: "step_plan", apiKey: "global-step-key", uid: "account-1" }),
		);
		await writeFile(
			join(legacyProject, "config.json"),
			JSON.stringify({
				activeModel: "project-profile",
				providers: {
					anthropic: {
						api: "anthropic-messages",
						baseUrl: "https://api.stepfun.com/step_plan/v1",
						models: [{ id: "project-profile", model: "step-project-model" }],
					},
				},
			}),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const globalAgentDir = join(home, ".step-cli", "agent");
		const projectSettings = JSON.parse(
			await readFile(join(workspace, ".step-cli", "settings.json"), "utf8"),
		) as Record<string, unknown>;
		const models = JSON.parse(await readFile(join(globalAgentDir, "models.json"), "utf8")) as {
			providers: Record<string, { models?: Array<{ id?: string }> }>;
		};
		expect(projectSettings).toMatchObject({ defaultProvider: STEP_PROVIDER_ID, defaultModel: "step-project-model" });
		expect(models.providers.anthropic).toBeUndefined();
		expect(models.providers.step?.models).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "step-project-model" })]),
		);

		const runtime = await ModelRuntime.create({
			authPath: join(globalAgentDir, "auth.json"),
			modelsPath: join(globalAgentDir, "models.json"),
			refreshOnCreate: false,
		});
		runtime.registerProvider(
			STEP_PROVIDER_ID,
			createStepProviderConfig({ apiBaseUrl: "https://api.stepfun.com/step_plan/v1" }),
		);
		const model = runtime.getModel(STEP_PROVIDER_ID, "step-project-model");
		expect((await runtime.getAuth(model!))?.auth.apiKey).toBe("global-step-key");
	});

	test("completes a chat request with the migrated model and credential", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: {
					model: "wire-chat-model",
					provider: "step",
					api: "openai-chat-completions",
					baseUrl: "https://legacy.example/v1",
				},
			}),
		);
		await writeFile(
			join(legacy, "auth.json"),
			JSON.stringify({ version: 1, profile: "step_plan", apiKey: "legacy-chat-key", uid: "uid-chat" }),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const agentDir = join(home, ".step-cli", "agent");
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		runtime.registerProvider(STEP_PROVIDER_ID, createStepProviderConfig({ apiBaseUrl: "https://step.example/v1" }));

		const model = runtime.getModel(STEP_PROVIDER_ID, "wire-chat-model");
		expect(model).toMatchObject({
			id: "wire-chat-model",
			api: "openai-completions",
			baseUrl: "https://legacy.example/v1",
		});
		expect(model).toBeDefined();

		let requestUrl: string | undefined;
		let requestInit: RequestInit | undefined;
		const fetch = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
			requestUrl = String(input);
			requestInit = init;
			return new Response(
				[
					'data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"wire-chat-model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"logprobs":null,"finish_reason":null}]}',
					"",
					'data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"wire-chat-model","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
					"",
					"data: [DONE]",
					"",
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		};

		const response = await runtime.completeSimple(
			model!,
			{
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			},
			{ fetch },
		);
		expect(response.stopReason).toBe("stop");
		expect(response.content).toEqual([{ type: "text", text: "hello" }]);
		expect(requestUrl).toBe("https://legacy.example/v1/chat/completions");
		expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer legacy-chat-key");
		expect(JSON.parse(String(requestInit?.body))).toMatchObject({
			model: "wire-chat-model",
			messages: [{ role: "user", content: "hello" }],
			stream: true,
		});
	});

	test("keeps top-level models with an explicit provider in that provider catalog", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: {
					model: "claude-default",
					provider: "anthropic",
					api: "anthropic-messages",
					baseUrl: "https://anthropic.example/v1",
					apiKey: "anthropic-key",
				},
				models: [
					{
						id: "openai-profile",
						provider: "openai",
						api: "openai-chat-completions",
						model: "gpt-wire",
						baseUrl: "https://openai.example/v1",
						apiKey: "openai-key",
					},
				],
			}),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const models = JSON.parse(await readFile(join(home, ".step-cli", "agent", "models.json"), "utf8")) as {
			providers: Record<string, { models?: Array<Record<string, unknown>> }>;
		};
		const settings = JSON.parse(await readFile(join(home, ".step-cli", "agent", "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(models.providers.anthropic?.models).toEqual(
			expect.not.arrayContaining([expect.objectContaining({ id: "gpt-wire" })]),
		);
		expect(models.providers.openai?.models).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "gpt-wire" })]),
		);
		expect(settings).toMatchObject({ defaultProvider: "anthropic", defaultModel: "claude-default" });
		const runtime = await ModelRuntime.create({
			authPath: join(home, ".step-cli", "agent", "auth.json"),
			modelsPath: join(home, ".step-cli", "agent", "models.json"),
			refreshOnCreate: false,
		});
		expect(runtime.getModel("openai", "gpt-wire")).toMatchObject({
			provider: "openai",
			api: "openai-completions",
			baseUrl: "https://openai.example/v1",
		});

		const auth = JSON.parse(await readFile(join(home, ".step-cli", "agent", "auth.json"), "utf8")) as Record<
			string,
			{ key?: string }
		>;
		expect(auth.anthropic?.key).toBe("anthropic-key");
		expect(auth.openai?.key).toBe("openai-key");
	});

	test("derives the wire API from an explicit legacy provider when api is omitted", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: { model: "claude-default", provider: "anthropic", baseUrl: "https://anthropic.example/v1" },
				models: [
					{ id: "openai-profile", provider: "openai", model: "gpt-wire", baseUrl: "https://openai.example/v1" },
				],
			}),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const models = JSON.parse(await readFile(join(home, ".step-cli", "agent", "models.json"), "utf8")) as {
			providers: Record<string, { api?: string }>;
		};
		expect(models.providers.openai?.api).toBe("openai-completions");
	});

	test("does not synthesize an unusable fallback provider for provider-qualified models", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				activeModel: "openai/open-profile",
				models: [
					{
						id: "open-profile",
						provider: "openai",
						model: "gpt-wire",
						api: "openai-chat-completions",
						baseUrl: "https://openai.example/v1",
						apiKey: "openai-key",
					},
				],
			}),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const models = JSON.parse(await readFile(join(home, ".step-cli", "agent", "models.json"), "utf8")) as {
			providers: Record<string, { models?: Array<Record<string, unknown>> }>;
		};
		const settings = JSON.parse(await readFile(join(home, ".step-cli", "agent", "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(models.providers.step).toBeUndefined();
		expect(models.providers.openai?.models).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "gpt-wire", name: "open-profile" })]),
		);
		expect(settings).toMatchObject({ defaultProvider: "openai", defaultModel: "gpt-wire" });
	});

	test("shares a migrated Step login with provider-qualified models that inherit the old key", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({
				model: {
					model: "step-wire",
					provider: "anthropic",
					api: "anthropic-messages",
					baseUrl: "https://step.example/v1",
				},
				models: [
					{
						id: "openai-profile",
						provider: "openai",
						model: "gpt-wire",
						api: "openai-chat-completions",
						baseUrl: "https://openai.example/v1",
					},
				],
			}),
		);
		await writeFile(
			join(legacy, "auth.json"),
			JSON.stringify({ version: 1, profile: "step_plan", apiKey: "shared-step-key" }),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const agentDir = join(home, ".step-cli", "agent");
		const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as Record<
			string,
			Record<string, unknown>
		>;
		expect(auth.step?.access).toBe("shared-step-key");
		expect(auth.openai).toMatchObject({ type: "api_key", key: "shared-step-key" });

		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		const model = runtime.getModel("openai", "gpt-wire");
		expect(model).toBeDefined();
		expect((await runtime.getAuth(model!))?.auth.apiKey).toBe("shared-step-key");
	});

	test("loads global and project settings only from the Step CLI directories", async () => {
		const { home, workspace } = await makeHome();
		const previousConfigDir = process.env.STEP_CLI_CONFIG_DIR;
		const previousArgv1 = process.argv[1];
		process.env.STEP_CLI_CONFIG_DIR = ".step-cli";
		// CONFIG_DIR_NAME only honors Step overrides for a real Step entrypoint;
		// this test imports the module dynamically under Vitest's ordinary argv.
		process.argv[1] = "/tmp/step";
		vi.resetModules();

		try {
			const { CONFIG_DIR_NAME } = await import("../src/config.ts");
			const { SettingsManager } = await import("../src/core/settings-manager.ts");
			expect(CONFIG_DIR_NAME).toBe(".step-cli");

			const cliAgent = join(home, ".step-cli", "agent");
			const cliProject = join(workspace, ".step-cli");
			const piAgent = join(home, ".pi", "agent");
			const piProject = join(workspace, ".pi");
			await mkdir(cliAgent, { recursive: true });
			await mkdir(cliProject, { recursive: true });
			await mkdir(piAgent, { recursive: true });
			await mkdir(piProject, { recursive: true });
			await writeFile(join(cliAgent, "settings.json"), JSON.stringify({ defaultModel: "cli-global" }));
			await writeFile(join(cliProject, "settings.json"), JSON.stringify({ defaultModel: "cli-project" }));
			await writeFile(join(piAgent, "settings.json"), JSON.stringify({ defaultModel: "pi-global" }));
			await writeFile(join(piProject, "settings.json"), JSON.stringify({ defaultModel: "pi-project" }));

			const manager = SettingsManager.create(workspace, cliAgent);
			expect(manager.getGlobalSettings().defaultModel).toBe("cli-global");
			expect(manager.getProjectSettings().defaultModel).toBe("cli-project");
			expect(manager.getDefaultModel()).toBe("cli-project");

			const piOnlyRoot = join(home, "pi-only");
			const piOnlyWorkspace = join(piOnlyRoot, "workspace");
			await mkdir(join(piOnlyRoot, ".pi", "agent"), { recursive: true });
			await mkdir(join(piOnlyWorkspace, ".pi"), { recursive: true });
			await writeFile(
				join(piOnlyRoot, ".pi", "agent", "settings.json"),
				JSON.stringify({ defaultModel: "pi-only-global" }),
			);
			await writeFile(
				join(piOnlyWorkspace, ".pi", "settings.json"),
				JSON.stringify({ defaultModel: "pi-only-project" }),
			);
			const piOnlyManager = SettingsManager.create(piOnlyWorkspace, join(piOnlyRoot, ".step-cli", "agent"));
			expect(piOnlyManager.getGlobalSettings()).toEqual({});
			expect(piOnlyManager.getProjectSettings()).toEqual({});
			expect(piOnlyManager.getDefaultModel()).toBeUndefined();
		} finally {
			if (previousConfigDir === undefined) delete process.env.STEP_CLI_CONFIG_DIR;
			else process.env.STEP_CLI_CONFIG_DIR = previousConfigDir;
			if (previousArgv1 === undefined) delete process.argv[1];
			else process.argv[1] = previousArgv1;
			vi.resetModules();
		}
	});

	test("imports the retired Pi namespace and archives it without sessions", async () => {
		const { home, workspace } = await makeHome();
		const retired = join(home, ".step-harness");
		const retiredAgent = join(retired, "agent");
		await mkdir(join(retiredAgent, "sessions"), { recursive: true });
		await writeFile(join(retiredAgent, "settings.json"), JSON.stringify({ defaultModel: "retired-model" }));
		await writeFile(
			join(retiredAgent, "models.json"),
			JSON.stringify({ providers: { step: { api: "anthropic-messages", models: [{ id: "retired-model" }] } } }),
		);
		await writeFile(
			join(retiredAgent, "auth.json"),
			JSON.stringify({ step: { type: "api_key", key: "retired-key" } }),
		);
		await writeFile(join(retiredAgent, "sessions", "old.jsonl"), "old session");

		const first = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		const agent = join(home, ".step-cli", "agent");
		expect(first.migrated).toBe(true);
		expect(JSON.parse(await readFile(join(agent, "settings.json"), "utf8"))).toMatchObject({
			defaultModel: "retired-model",
		});
		expect(JSON.parse(await readFile(join(agent, "auth.json"), "utf8"))).toMatchObject({
			step: { key: "retired-key" },
		});
		expect(await readFile(join(home, ".step-harness.bak", "agent", "settings.json"), "utf8")).toContain(
			"retired-model",
		);
		await expect(stat(join(home, ".step-harness.bak", "agent", "sessions"))).rejects.toMatchObject({
			code: "ENOENT",
		});

		const second = await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(second.roots.find((root) => root.scope === "global")?.migrated).toBe(false);
		expect(await readFile(join(home, ".step-harness.bak", "agent", "settings.json"), "utf8")).toContain(
			"retired-model",
		);
	});

	test("archives in-place rich config files after projecting them", async () => {
		const { home, workspace } = await makeHome();
		const legacy = join(home, ".step-cli");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "config.json"),
			JSON.stringify({ model: { provider: "step", model: "legacy-model" } }),
		);
		await writeFile(
			join(legacy, "auth.json"),
			JSON.stringify({ version: 1, profile: "step_plan", apiKey: "legacy-key" }),
		);

		await migrateStepConfig({ homeDir: home, cwd: workspace, env: {} });
		expect(await readFile(join(home, ".step-cli.bak", "config.json"), "utf8")).toContain("legacy-model");
		expect(await readFile(join(home, ".step-cli.bak", "auth.json"), "utf8")).toContain("legacy-key");
		expect(await readFile(join(home, ".step-cli", "agent", "settings.json"), "utf8")).toContain("legacy-model");
	});
});
