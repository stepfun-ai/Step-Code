import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../packages/coding-agent/src/config.ts";
import { ModelRuntime } from "../../../packages/coding-agent/src/core/model-runtime.ts";
import type { ResolvedPaths } from "../../../packages/coding-agent/src/core/package-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../../packages/coding-agent/src/core/settings-manager.ts";
import { ProjectTrustStore } from "../../../packages/coding-agent/src/core/trust-manager.ts";
import { main } from "../../../packages/coding-agent/src/main.ts";
import { ConfigSelectorComponent } from "../src/ui/view/dialogs/config-selector.ts";
import { handlePackageCommand } from "../../../packages/coding-agent/src/package-manager-cli.ts";

describe("package commands", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalPath: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalExecPath: string;

	async function runPackageCommandDirectly(args: string[]): Promise<void> {
		expect(await handlePackageCommand(args)).toBe(true);
	}

	function extensionPaths(
		packageRoot: string,
		source: string,
		scope: "user" | "project",
		names: string[],
	): ResolvedPaths {
		return {
			extensions: names.map((name) => ({
				path: join(packageRoot, "extensions", name),
				enabled: true,
				metadata: { source, scope, origin: "package", baseDir: packageRoot },
			})),
			skills: [],
			prompts: [],
			themes: [],
		};
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `step-package-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "local-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPath = process.env.PATH;
		originalExitCode = process.exitCode;
		originalExecPath = process.execPath;
		process.exitCode = undefined;
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			if (code === undefined || code === null || Number(code) === 0) {
				process.exitCode = undefined;
			} else {
				process.exitCode = code;
			}
			return undefined as never;
		}) as typeof process.exit);
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should persist global relative local package paths relative to settings.json", async () => {
		const relativePkgDir = join(projectDir, "packages", "local-package");
		mkdirSync(relativePkgDir, { recursive: true });

		await main(["install", "./packages/local-package"]);

		const settingsPath = join(agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		const resolvedFromSettings = realpathSync(join(agentDir, stored));
		expect(resolvedFromSettings).toBe(realpathSync(relativePkgDir));
	});

	it("should remove local packages using a path with a trailing slash", async () => {
		await main(["install", `${packageDir}/`]);

		const settingsPath = join(agentDir, "settings.json");
		const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(installedSettings.packages?.length).toBe(1);

		await main(["remove", `${packageDir}/`]);

		const removedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(removedSettings.packages ?? []).toHaveLength(0);
	});

	it("skips untrusted project package settings", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses remembered project trust for list", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("overrides remembered trust for list with --no-approve", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--no-approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("approves project trust for list with --approve", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses default project trust for list", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses project_trust extensions for package commands", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(
				main(["list"], {
					extensionFactories: [
						(pi) => {
							pi.on("project_trust", () => ({ trusted: "yes" }));
						},
					],
				}),
			).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("does not prompt or ask extensions for project trust during update", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const fakeNpmPath = join(tempDir, "fake-project-npm.cjs");
		const recordPath = join(tempDir, "project-update.json");
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(process.argv.slice(2)));`,
		);
		writeFileSync(
			join(projectDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["npm:fake-package"], npmCommand: [originalExecPath, fakeNpmPath] }),
		);
		let projectTrustCalled = false;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(
				main(["update", "--extensions"], {
					extensionFactories: [
						(pi) => {
							pi.on("project_trust", () => {
								projectTrustCalled = true;
								return { trusted: "yes" };
							});
						},
					],
				}),
			).resolves.toBeUndefined();

			expect(projectTrustCalled).toBe(false);
			expect(existsSync(recordPath)).toBe(false);
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses saved project trust during update", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		const fakeNpmPath = join(tempDir, "fake-trusted-project-npm.cjs");
		const recordPath = join(tempDir, "trusted-project-update.json");
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(process.argv.slice(2)));`,
		);
		writeFileSync(
			join(projectDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["npm:fake-package"], npmCommand: [originalExecPath, fakeNpmPath] }),
		);
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "--extensions"])).resolves.toBeUndefined();

			expect(existsSync(recordPath)).toBe(true);
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("lets trust.json override default project trust", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, false);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("blocks local package changes when project is untrusted", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "-l", "./local-package"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Project is not trusted. Use --approve to modify local package config.");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("allows local package install to initialize fresh project settings", async () => {
		await main(["install", "-l", packageDir]);

		const settingsPath = join(projectDir, ".pi", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		expect(realpathSync(join(projectDir, ".pi", stored))).toBe(realpathSync(packageDir));
		expect(process.exitCode).toBeUndefined();
	});

	it("shows install subcommand help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--help"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Usage:");
			expect(stdout).toContain("step install <source> [-l]");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("refreshes only model catalogs with update --models", async () => {
		const refresh = vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() }));
		const getProviders = vi.fn(() => [{ id: "openai" }]);
		const create = vi
			.spyOn(ModelRuntime, "create")
			.mockResolvedValue({ refresh, getProviders } as unknown as ModelRuntime);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(runPackageCommandDirectly(["update", "--models"])).resolves.toBeUndefined();

		expect(create).toHaveBeenCalledWith({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
			signal: expect.any(AbortSignal),
		});
		expect(refresh).toHaveBeenCalledWith({
			allowNetwork: true,
			force: true,
			signal: expect.any(AbortSignal),
		});
		expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("Model catalogs refreshed");
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("rejects update --models combined with another update target", async () => {
		const create = vi.spyOn(ModelRuntime, "create");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(runPackageCommandDirectly(["update", "--models", "--self"])).resolves.toBeUndefined();

		expect(create).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"--models cannot be combined with --self",
		);
		expect(process.exitCode).toBe(1);
	});

	it("cycles project package overrides in config local mode", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ packages: ["npm:pi-tools"] }));
		const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: true });
		const resolvedPaths = extensionPaths(join(tempDir, "pkg"), "npm:pi-tools", "user", ["bar.ts"]);
		const selector = new ConfigSelectorComponent(
			{ global: resolvedPaths, project: resolvedPaths },
			settingsManager,
			projectDir,
			agentDir,
			() => {},
			() => {},
			() => {},
			24,
			"project",
		);

		selector.getResourceList().handleInput(" ");
		expect(settingsManager.getProjectSettings().packages).toEqual([
			{ source: "npm:pi-tools", autoload: false, extensions: ["-extensions/bar.ts"] },
		]);

		selector.getResourceList().handleInput(" ");
		expect(settingsManager.getProjectSettings().packages).toEqual([
			{ source: "npm:pi-tools", autoload: false, extensions: ["+extensions/bar.ts"] },
		]);

		selector.getResourceList().handleInput(" ");
		expect(settingsManager.getProjectSettings().packages).toEqual([]);
	});

	it("shows a friendly error for unknown install options", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--unknown"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --unknown for "install".');
			expect(stderr).toContain('Use "step --help" or "step install <source> [-l] [--approve|--no-approve]".');
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for missing install source", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Missing install source.");
			expect(stderr).toContain("Usage: step install <source> [-l]");
			expect(stderr).not.toContain("at ");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("suggests the configured source when update input omits the npm prefix", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-formatter"] }, null, 2));

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "pi-formatter"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Did you mean npm:pi-formatter?");
			expect(stdout).not.toContain("Updated pi-formatter");
			expect(process.exitCode).toBe(1);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
			expect(settings.packages).toContain("npm:pi-formatter");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	describe("update self-unsupported path", () => {
		it.each([
			["bare update", ["update"]],
			["--self", ["update", "--self"]],
			["positional self", ["update", "self"]],
			["product name", ["update", "step"]],
			["legacy alias", ["update", "pi"]],
		])("reports self-update is unsupported for %s and exits 1", async (_label, argv) => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			try {
				await expect(main(argv)).resolves.toBeUndefined();

				const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
				const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
				expect(stderr).toContain("cannot self-update this installation");
				expect(stdout).not.toContain("Updated packages");
				expect(process.exitCode).toBe(1);
			} finally {
				errorSpy.mockRestore();
				logSpy.mockRestore();
			}
		});

		it("routes update --self --extensions to the extensions update instead of the unsupported error", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			try {
				await expect(main(["update", "--self", "--extensions"])).resolves.toBeUndefined();

				const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
				const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
				expect(stderr).not.toContain("cannot self-update this installation");
				expect(stdout).toContain("Updated packages");
				expect(process.exitCode).not.toBe(1);
			} finally {
				errorSpy.mockRestore();
				logSpy.mockRestore();
			}
		});
	});
});
