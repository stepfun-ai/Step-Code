/**
 * Step-named entry points for the Pi session services.
 *
 * These functions deliberately contain no runtime behavior of their own. They
 * select Step's storage roots and decorate a supplied Pi SettingsManager; the
 * actual session construction, persistence, and agent loop remain in Pi.
 */

import type { AgentSessionServices, CreateAgentSessionServicesOptions } from "../core/agent-session-services.ts";
import { createAgentSessionServices } from "../core/agent-session-services.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../core/sdk.ts";
import { createAgentSession } from "../core/sdk.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { resolvePath } from "../utils/paths.ts";
import { resolveStepAgentDir, resolveStepConfigDir } from "./environment.ts";
import { createStepSessionManager, wrapStepSessionManager } from "./session.ts";
import {
	createStepSettingsManager,
	decorateStepSettingsManager,
	type StepSettingsDecoratorOptions,
	type StepSettingsManager,
} from "./settings-manager.ts";

export interface CreateStepAgentSessionOptions
	extends Omit<CreateAgentSessionOptions, "agentDir" | "cwd" | "settingsManager"> {
	/** Workspace root used for project-local Step settings. */
	cwd?: string;
	/** Step agent directory. Defaults to the StepCode global directory. */
	agentDir?: string;
	/** Optional explicit session root; defaults to Pi's per-cwd Step layout. */
	sessionDir?: string;
	/** An existing Pi manager to decorate instead of creating one. */
	settingsManager?: SettingsManager;
	/** Explicit sidecar path overrides when decorating an existing manager. */
	stepSettingsPaths?: StepSettingsDecoratorOptions["paths"];
}

export interface CreateStepAgentSessionServicesOptions
	extends Omit<CreateAgentSessionServicesOptions, "agentDir" | "cwd" | "settingsManager"> {
	/** Workspace root used for project-local Step settings. */
	cwd: string;
	/** Step agent directory. Defaults to the StepCode global directory. */
	agentDir?: string;
	/** An existing Pi manager to decorate instead of creating one. */
	settingsManager?: SettingsManager;
	/** Explicit sidecar path overrides when decorating an existing manager. */
	stepSettingsPaths?: StepSettingsDecoratorOptions["paths"];
}

/** Pi services with the Step settings decorator visible to TypeScript callers. */
export type StepAgentSessionServices = Omit<AgentSessionServices, "settingsManager"> & {
	settingsManager: StepSettingsManager;
};

function isStepSettingsManager(manager: SettingsManager): manager is StepSettingsManager {
	const candidate = manager as Partial<StepSettingsManager>;
	return typeof candidate.getStepSettings === "function" && typeof candidate.getPiSettingsManager === "function";
}

function resolveStepRuntimePaths(
	cwd: string | undefined,
	agentDir: string | undefined,
	configDirName: string | undefined,
): { cwd: string; agentDir: string; configDirName: string } {
	return {
		cwd: resolvePath(cwd ?? process.cwd()),
		agentDir: resolvePath(agentDir?.trim() || resolveStepAgentDir()),
		configDirName: configDirName?.trim() || resolveStepConfigDir(),
	};
}

function ensureStepSettingsManager(
	manager: SettingsManager | undefined,
	paths: { cwd: string; agentDir: string; configDirName: string },
	stepSettingsPaths: StepSettingsDecoratorOptions["paths"] | undefined,
): StepSettingsManager {
	if (manager && isStepSettingsManager(manager)) return manager;
	if (manager) {
		return decorateStepSettingsManager(manager, {
			cwd: paths.cwd,
			agentDir: paths.agentDir,
			configDirName: paths.configDirName,
			paths: stepSettingsPaths,
		});
	}
	return createStepSettingsManager(paths.cwd, paths.agentDir, {
		configDirName: paths.configDirName,
		paths: stepSettingsPaths,
	});
}

/** Create a Pi AgentSession with Step's settings decorator installed. */
export async function createStepAgentSession(
	options: CreateStepAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
	const paths = resolveStepRuntimePaths(options.cwd, options.agentDir, options.configDirName);
	const settingsManager = ensureStepSettingsManager(options.settingsManager, paths, options.stepSettingsPaths);
	const sessionManager = options.sessionManager
		? wrapStepSessionManager(options.sessionManager, { agentDir: paths.agentDir })
		: createStepSessionManager(paths.cwd, {
				agentDir: paths.agentDir,
				sessionDir: options.sessionDir,
			});
	return createAgentSession({
		...options,
		cwd: paths.cwd,
		agentDir: paths.agentDir,
		configDirName: paths.configDirName,
		settingsManager,
		sessionManager,
	});
}

/** Create Pi's cwd-bound services with Step's settings decorator installed. */
export async function createStepAgentSessionServices(
	options: CreateStepAgentSessionServicesOptions,
): Promise<StepAgentSessionServices> {
	const paths = resolveStepRuntimePaths(options.cwd, options.agentDir, options.configDirName);
	const settingsManager = ensureStepSettingsManager(options.settingsManager, paths, options.stepSettingsPaths);
	return createAgentSessionServices({
		...options,
		cwd: paths.cwd,
		agentDir: paths.agentDir,
		configDirName: paths.configDirName,
		settingsManager,
	}) as Promise<StepAgentSessionServices>;
}
