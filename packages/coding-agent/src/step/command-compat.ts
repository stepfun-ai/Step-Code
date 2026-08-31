/**
 * Step's small top-level command compatibility layer.
 *
 * Pi owns the actual runtime and command implementations.  This module only
 * translates the legacy Step command spelling to Pi's public CLI flags, and
 * handles the few configuration inspection operations that Pi's package
 * manager does not provide.  Keeping this boundary separate makes upgrades to
 * Pi's parser/local runtime low-risk.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { migrateStepConfig } from "./config-migration.ts";
import { resolveStepAgentDir, resolveStepConfigDir } from "./environment.ts";

export type StepTopLevelCommand = "config" | "exec" | "models" | "resume";

export interface StepCommandCompatibilityResult {
	/** The rewritten argv for Pi's existing `main()` entry. */
	readonly args?: string[];
	/** Whether the caller should skip Pi's normal `main()` invocation. */
	readonly handled: boolean;
}

/**
 * Translate a legacy Step subcommand to Pi's native root flags.
 *
 * `undefined` means this is an ordinary root invocation.  A result with
 * `handled:false` is intentionally returned for translated commands so the
 * caller can pass `args` to `main()` without another command parser.
 */
export function translateStepCommandArgs(argv: readonly string[]): StepCommandCompatibilityResult | undefined {
	const [command, ...rest] = argv;
	if (!command) return undefined;

	switch (command) {
		case "exec":
			return { handled: false, args: translateExecArgs(rest) };
		case "resume":
			return { handled: false, args: translateResumeArgs(rest) };
		case "models":
			return { handled: false, args: translateModelsArgs(rest) };
		default:
			return undefined;
	}
}

/** Return whether argv selects a Step config inspection command. */
export function isStepConfigCommand(argv: readonly string[]): boolean {
	return argv[0] === "config" && ["path", "show", "init", "migrate"].includes(argv[1] ?? "");
}

export interface StepConfigCommandIo {
	stdout?: Pick<NodeJS.WriteStream, "write">;
	stderr?: Pick<NodeJS.WriteStream, "write">;
	cwd?: string;
	homeEnv?: Record<string, string | undefined>;
}

/**
 * Run the Step-owned config inspection/migration commands.
 *
 * The files use Pi's native schema (`settings.json`, `models.json`, and
 * `auth.json`) but live below `.step-harness`; secrets are never printed.
 */
export async function runStepConfigCommand(argv: readonly string[], io: StepConfigCommandIo = {}): Promise<void> {
	const stdout = io.stdout ?? process.stdout;
	const stderr = io.stderr ?? process.stderr;
	const cwd = resolve(io.cwd ?? process.cwd());
	const env = io.homeEnv ?? process.env;
	const agentDir = resolveStepAgentDir(env);
	const configDirName = resolveStepConfigDir(env);
	const projectDir = join(cwd, configDirName);
	const paths = {
		agentDir,
		globalSettings: join(agentDir, "settings.json"),
		globalModels: join(agentDir, "models.json"),
		globalAuth: join(agentDir, "auth.json"),
		projectDir,
		projectSettings: join(projectDir, "settings.json"),
	};

	const subcommand = argv[1];
	if (subcommand === "migrate") {
		const report = await migrateStepConfig({ cwd, env });
		for (const warning of report.warnings) stderr.write(`[step migration] ${warning}\n`);
		stdout.write(
			`${JSON.stringify(
				{
					migrated: report.migrated,
					defaultProvider: report.defaultProvider,
					defaultModel: report.defaultModel,
					roots: report.roots,
				},
				null,
				2,
			)}\n`,
		);
		return;
	}

	if (subcommand === "path") {
		const json = argv.includes("--json");
		const payload = {
			globalAgentDir: paths.agentDir,
			globalSettingsPath: paths.globalSettings,
			globalModelsPath: paths.globalModels,
			globalAuthPath: paths.globalAuth,
			workspaceConfigDir: paths.projectDir,
			workspaceSettingsPath: paths.projectSettings,
			existingPaths: Object.values(paths).filter((value) => existsSync(value)),
		};
		if (json) {
			stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		} else {
			stdout.write(
				`${[
					`global: ${paths.agentDir}`,
					`global settings: ${paths.globalSettings}`,
					`global models: ${paths.globalModels}`,
					`global auth: ${paths.globalAuth}`,
					`workspace: ${paths.projectDir}`,
					`workspace settings: ${paths.projectSettings}`,
					`existing: ${payload.existingPaths.length > 0 ? payload.existingPaths.join(", ") : "(none)"}`,
				].join("\n")}\n`,
			);
		}
		return;
	}

	if (subcommand === "init") {
		const scope = readOption(argv, "--scope") ?? "user";
		if (scope !== "user" && scope !== "workspace") {
			throw new Error(`Invalid config scope "${scope}". Use user or workspace.`);
		}
		const explicitPath = readOption(argv, "--path");
		const target = resolve(explicitPath ?? (scope === "workspace" ? paths.projectSettings : paths.globalSettings));
		const force = argv.includes("--force");
		if (existsSync(target) && !force) {
			throw new Error(`Config file already exists: ${target} (pass --force to overwrite)`);
		}
		await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
		const template = {
			defaultProvider: "step",
			defaultModel: "step-3.7-flash",
		};
		await writeFile(target, `${JSON.stringify(template, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		stdout.write(`Wrote Step Pi settings template: ${target}\n`);
		return;
	}

	if (subcommand === "show") {
		const json = argv.includes("--json");
		const readJson = async (path: string): Promise<unknown> => {
			try {
				return JSON.parse(await readFile(path, "utf8")) as unknown;
			} catch {
				return undefined;
			}
		};
		const payload = {
			paths,
			globalSettings: await readJson(paths.globalSettings),
			globalModels: await readJson(paths.globalModels),
			workspaceSettings: await readJson(paths.projectSettings),
			// Auth presence is useful for diagnostics; credential material is not.
			auth: { configured: existsSync(paths.globalAuth), path: paths.globalAuth },
		};
		if (json) {
			stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		} else {
			stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		}
		return;
	}

	throw new Error(`Usage: step config ${"path|show|init|migrate"}`);
}

function translateExecArgs(args: readonly string[]): string[] {
	const result: string[] = ["--print"];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--output-format" || arg.startsWith("--output-format=")) {
			const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
			if (value === "json") result.push("--mode", "json");
			else if (value === "text" || value === undefined) {
				// Pi's default print mode is text.
			} else {
				// Keep unsupported formats visible to Pi's normal diagnostics rather
				// than silently dropping a requested stream protocol.
				result.push("--output-format", value);
			}
			continue;
		}
		if (arg === "--json") {
			result.push("--mode", "json");
			continue;
		}
		result.push(arg);
	}
	return result;
}

function translateResumeArgs(args: readonly string[]): string[] {
	const result: string[] = ["--resume"];
	const sessionId = args.find((arg) => !arg.startsWith("-"));
	if (sessionId) result.push("--session-id", sessionId);
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === sessionId) continue;
		result.push(arg);
	}
	return result;
}

function translateModelsArgs(args: readonly string[]): string[] {
	const subcommand = args[0];
	if (subcommand === "check") {
		// Pi has no probe command. Preserve an explicit, actionable failure rather
		// than treating `check` as a model search string.
		return ["--list-models", "--step-models-check-unsupported", ...args.slice(1)];
	}
	if (subcommand === "list" || subcommand === undefined) {
		return ["--list-models", ...args.slice(subcommand ? 1 : 0)];
	}
	return ["--list-models", ...args];
}

function readOption(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index >= 0) return argv[index + 1];
	const prefix = `${name}=`;
	const inline = argv.find((arg) => arg.startsWith(prefix));
	return inline?.slice(prefix.length);
}
