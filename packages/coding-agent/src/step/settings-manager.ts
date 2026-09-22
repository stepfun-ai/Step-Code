/**
 * Step settings facade.
 *
 * Pi owns the canonical settings schema and its global/project merge rules.
 * Step adds a small product-owned namespace in a sidecar file so product
 * policy (for example `ask`/`autopilot`) does not leak into Pi's settings
 * schema. The returned object is a transparent decorator: every Pi method is
 * still available and is invoked against the original SettingsManager.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { SettingsManager, type SettingsManagerCreateOptions } from "../core/settings-manager.ts";
import { stripBom } from "../utils/text.ts";
import { readStepConfig, StepTomlSettingsStorage, writeStepConfig } from "./config-toml.ts";
import { resolveStepAgentDir, resolveStepConfigDir } from "./environment.ts";
import {
	getStepPermissionPreset,
	normalizeStepPermissionMode,
	type StepNonInteractiveApproval,
	type StepPermissionMode,
	type StepPermissionPresetId,
} from "./permissions.ts";

/** Product-owned settings persisted by the Step decorator. */
export interface StepSettings {
	/** Initial product approval preset for a new session. */
	permissionPreset?: StepPermissionPresetId;
	/** Optional low-level approval mode override. */
	approvalMode?: StepPermissionMode;
	/** Fallback used when no interactive approval callback exists. */
	nonInteractiveApproval?: StepNonInteractiveApproval;
	/** Enables the bounded model-error continuation ladder. */
	autoResume?: boolean;
	/** Enables the user feedback submission flow. Defaults to enabled. */
	feedbackEnabled?: boolean;
}

type JsonObject = Record<string, unknown>;

export interface StepSettingsPaths {
	global: string;
	project: string;
}

export interface StepSettingsDecoratorOptions {
	/** Workspace cwd used to derive the project sidecar path. */
	cwd?: string;
	/** Pi agent directory used to derive the global sidecar path. */
	agentDir?: string;
	/** Project resource directory name used by the Step wrapper. */
	configDirName?: string;
	/** Explicit sidecar paths, useful for embedded hosts and tests. */
	paths?: Partial<StepSettingsPaths>;
	/** Initial project trust state. Defaults to the wrapped manager's state. */
	projectTrusted?: boolean;
}

export interface StepSettingsManagerCreateOptions extends SettingsManagerCreateOptions, StepSettingsDecoratorOptions {}

export interface StepSettingsManager extends SettingsManager {
	/** Return the wrapped Pi manager (useful when a host needs identity checks). */
	getPiSettingsManager(): SettingsManager;
	/** Return the effective product settings after global/project overlay. */
	getStepSettings(): StepSettings;
	/** Return one sidecar scope without exposing the mutable internal object. */
	getStepGlobalSettings(): StepSettings;
	getStepProjectSettings(): StepSettings;
	/** Return the sidecar paths used by this decorator. */
	getStepSettingsPaths(): StepSettingsPaths;
	/** Replace the selected product fields in the global sidecar. */
	setStepSettings(settings: Partial<StepSettings>): void;
	/** Replace the selected product fields in the project sidecar. */
	setProjectStepSettings(settings: Partial<StepSettings>): void;
	/** Write fields back to the scope that currently overrides them. */
	setEffectiveStepSettings(settings: Partial<StepSettings>): void;
	getStepPermissionPreset(): StepPermissionPresetId | undefined;
	setStepPermissionPreset(preset: StepPermissionPresetId): void;
	getStepApprovalMode(): StepPermissionMode | undefined;
	setStepApprovalMode(mode: StepPermissionMode | undefined): void;
	getStepNonInteractiveApproval(): StepNonInteractiveApproval | undefined;
	setStepNonInteractiveApproval(mode: StepNonInteractiveApproval | undefined): void;
	getStepAutoResume(): boolean | undefined;
	setStepAutoResume(enabled: boolean | undefined): void;
}

interface ReadResult {
	exists: boolean;
	value?: JsonObject;
	error?: Error;
}

interface StoreError {
	scope: "global" | "project";
	path: string;
	error: Error;
}

function asObject(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function readJson(path: string): ReadResult {
	try {
		if (path.endsWith(".toml")) {
			const parsed = readStepConfig(path);
			delete parsed.mcp_servers;
			return { exists: true, value: parsed as JsonObject };
		}
		const parsed = JSON.parse(stripBom(readFileSync(path, "utf8"))) as unknown;
		const value = asObject(parsed);
		return value ? { exists: true, value } : { exists: true, error: new Error("expected a JSON object") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
		return { exists: true, error: error instanceof Error ? error : new Error(String(error)) };
	}
}

function merge(base: JsonObject, overrides: JsonObject): JsonObject {
	const result = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) continue;
		const baseObject = asObject(result[key]);
		const overrideObject = asObject(value);
		result[key] = baseObject && overrideObject ? merge(baseObject, overrideObject) : clone(value);
	}
	return result;
}

function normalizeSettings(value: JsonObject): StepSettings {
	const result: StepSettings = {};
	// Older Step configs used both a top-level `approval` object and a nested
	// `tools.approval` object. Keep both candidates in precedence order, but do
	// not let an invalid higher-priority value hide a valid lower-priority one.
	const approval = asObject(value.approval);
	const toolsApproval = asObject(asObject(value.tools)?.approval);
	const presetCandidates = [value.permissionPreset, value.permissionMode, approval?.preset, toolsApproval?.preset];
	for (const candidate of presetCandidates) {
		if (typeof candidate !== "string") continue;
		const preset = getStepPermissionPreset(candidate);
		if (preset) {
			result.permissionPreset = preset.id;
			break;
		}
	}

	const modeCandidates = [value.approvalMode, approval?.mode, toolsApproval?.mode];
	for (const candidate of modeCandidates) {
		if (typeof candidate !== "string") continue;
		const mode = normalizeStepPermissionMode(candidate);
		if (mode) {
			result.approvalMode = mode;
			break;
		}
	}

	const nonInteractiveCandidates = [
		value.nonInteractiveApproval,
		value.noninteractiveApproval,
		approval?.nonInteractive,
		approval?.noninteractive,
		toolsApproval?.nonInteractive,
		toolsApproval?.noninteractive,
	];
	for (const candidate of nonInteractiveCandidates) {
		if (typeof candidate !== "string") continue;
		const normalized = candidate.trim().toLowerCase();
		if (normalized === "allow" || normalized === "deny") {
			result.nonInteractiveApproval = normalized;
			break;
		}
	}

	const autoResumeCandidates = [
		value.autoResume,
		value.autopilot,
		approval?.autoResume,
		approval?.autopilot,
		toolsApproval?.autoResume,
		toolsApproval?.autopilot,
	];
	for (const candidate of autoResumeCandidates) {
		if (typeof candidate === "boolean") {
			result.autoResume = candidate;
			break;
		}
	}

	const feedbackEnabledCandidates = [value.feedbackEnabled, asObject(value.feedback)?.enabled];
	for (const candidate of feedbackEnabledCandidates) {
		if (typeof candidate === "boolean") {
			result.feedbackEnabled = candidate;
			break;
		}
	}
	return result;
}

const STEP_SETTING_ALIASES: Record<keyof StepSettings, readonly string[]> = {
	permissionPreset: ["permissionMode"],
	approvalMode: [],
	nonInteractiveApproval: ["noninteractiveApproval"],
	autoResume: ["autopilot"],
	feedbackEnabled: [],
};

const STEP_SETTING_NESTED_ALIASES: Record<keyof StepSettings, readonly (readonly string[])[]> = {
	permissionPreset: [
		["approval", "preset"],
		["tools", "approval", "preset"],
	],
	approvalMode: [
		["approval", "mode"],
		["tools", "approval", "mode"],
	],
	nonInteractiveApproval: [
		["approval", "nonInteractive"],
		["approval", "noninteractive"],
		["tools", "approval", "nonInteractive"],
		["tools", "approval", "noninteractive"],
	],
	autoResume: [
		["approval", "autoResume"],
		["approval", "autopilot"],
		["tools", "approval", "autoResume"],
		["tools", "approval", "autopilot"],
	],
	feedbackEnabled: [["feedback", "enabled"]],
};

function deleteNestedAlias(root: JsonObject, path: readonly string[]): void {
	if (path.length === 0) return;
	const parents: Array<{ value: JsonObject; key: string }> = [];
	let current: JsonObject | undefined = root;
	for (let index = 0; index < path.length - 1; index += 1) {
		const next = asObject(current[path[index]!]);
		if (!next) return;
		parents.push({ value: current, key: path[index]! });
		current = next;
	}
	delete current[path[path.length - 1]!];
	for (let index = parents.length - 1; index >= 0; index -= 1) {
		const parent = parents[index]!;
		const child = asObject(parent.value[parent.key]);
		if (child && Object.keys(child).length === 0) delete parent.value[parent.key];
	}
}

function removeStepSettingAliases(root: JsonObject, key: keyof StepSettings): void {
	for (const alias of STEP_SETTING_ALIASES[key]) delete root[alias];
	for (const path of STEP_SETTING_NESTED_ALIASES[key]) deleteNestedAlias(root, path);
}

function validatePatch(settings: Partial<StepSettings>): Partial<StepSettings> {
	if (settings.permissionPreset !== undefined && !getStepPermissionPreset(settings.permissionPreset)) {
		throw new Error(`Invalid Step permission preset: ${String(settings.permissionPreset)}`);
	}
	if (
		settings.approvalMode !== undefined &&
		settings.approvalMode !== "confirm" &&
		settings.approvalMode !== "strict" &&
		settings.approvalMode !== "auto"
	) {
		throw new Error(`Invalid Step approval mode: ${String(settings.approvalMode)}`);
	}
	if (
		settings.nonInteractiveApproval !== undefined &&
		settings.nonInteractiveApproval !== "allow" &&
		settings.nonInteractiveApproval !== "deny"
	) {
		throw new Error(`Invalid Step non-interactive approval: ${String(settings.nonInteractiveApproval)}`);
	}
	if (settings.autoResume !== undefined && typeof settings.autoResume !== "boolean") {
		throw new Error(`Invalid Step autoResume setting: ${String(settings.autoResume)}`);
	}
	if (settings.feedbackEnabled !== undefined && typeof settings.feedbackEnabled !== "boolean") {
		throw new Error(`Invalid Step feedbackEnabled setting: ${String(settings.feedbackEnabled)}`);
	}
	const normalized = { ...settings };
	if (settings.permissionPreset !== undefined) {
		normalized.permissionPreset = getStepPermissionPreset(settings.permissionPreset)!.id;
	}
	if (settings.approvalMode !== undefined) {
		normalized.approvalMode = normalizeStepPermissionMode(settings.approvalMode)!;
	}
	return normalized;
}

function derivePaths(options: StepSettingsDecoratorOptions): StepSettingsPaths {
	const cwd = resolve(options.cwd ?? process.cwd());
	const agentDir = resolve(options.agentDir ?? resolveStepAgentDir());
	const configDirName = options.configDirName?.trim() || resolveStepConfigDir();
	return {
		global: resolve(options.paths?.global ?? join(dirname(agentDir), "config.toml")),
		project: resolve(options.paths?.project ?? join(cwd, configDirName, "config.toml")),
	};
}

/**
 * Small synchronous sidecar store. Setters on Pi's manager are synchronous as
 * well (their actual writes are queued), so keeping the product sidecar
 * synchronous gives callers the same read-after-write behavior. A lock is
 * acquired for every update and malformed files are never overwritten.
 */
class StepSettingsStore {
	private readonly paths: StepSettingsPaths;
	private global: JsonObject;
	private project: JsonObject;
	private projectTrusted: boolean;
	private errors: StoreError[] = [];

	constructor(paths: StepSettingsPaths, projectTrusted: boolean) {
		this.paths = paths;
		this.projectTrusted = projectTrusted;
		this.global = this.load("global");
		this.project = this.load("project");
	}

	getPaths(): StepSettingsPaths {
		return { ...this.paths };
	}

	getGlobal(): JsonObject {
		return clone(this.global);
	}

	getProject(): JsonObject {
		return this.projectTrusted ? clone(this.project) : {};
	}

	hasProjectSetting(key: keyof StepSettings): boolean {
		if (!this.projectTrusted) return false;
		if (
			this.project[key] !== undefined ||
			STEP_SETTING_ALIASES[key].some((alias) => this.project[alias] !== undefined)
		) {
			return true;
		}
		return STEP_SETTING_NESTED_ALIASES[key].some((path) => this.hasNestedPath(this.project, path));
	}

	getEffective(): JsonObject {
		return merge(this.global, this.projectTrusted ? this.project : {});
	}

	setProjectTrusted(trusted: boolean): void {
		this.projectTrusted = trusted;
		if (trusted) this.project = this.load("project");
		else this.project = {};
	}

	setGlobal(patch: Partial<StepSettings>): void {
		this.update("global", patch);
	}

	setProject(patch: Partial<StepSettings>): void {
		if (!this.projectTrusted) throw new Error("Project is not trusted; refusing to write project settings");
		this.update("project", patch);
	}

	reload(): void {
		this.global = this.load("global");
		this.project = this.load("project");
	}

	drainErrors(): StoreError[] {
		const errors = [...this.errors];
		this.errors = [];
		return errors;
	}

	private load(scope: "global" | "project"): JsonObject {
		if (scope === "project" && !this.projectTrusted) return {};
		const path = this.paths[scope];
		const result = readJson(path);
		if (result.error) {
			this.errors.push({
				scope,
				path,
				error: new Error(`Invalid Step settings file ${path}: ${result.error.message}`),
			});
			return {};
		}
		return result.value ?? {};
	}

	private hasNestedPath(root: JsonObject, path: readonly string[]): boolean {
		let current: JsonObject | undefined = root;
		for (let index = 0; index < path.length - 1; index += 1) {
			current = asObject(current?.[path[index]!]);
			if (!current) return false;
		}
		return current?.[path[path.length - 1]!] !== undefined;
	}

	private update(scope: "global" | "project", patch: Partial<StepSettings>): void {
		const path = this.paths[scope];
		let release: (() => void) | undefined;
		try {
			const directory = dirname(path);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			// Initialize with valid content for the selected format only on writes.
			if (!existsSync(path))
				writeFileSync(path, path.endsWith(".toml") ? "" : "{}\n", { encoding: "utf8", mode: 0o600 });
			release = this.acquireLockSyncWithRetry(path);
			const current = readJson(path);
			if (current.error) {
				this.errors.push({
					scope,
					path,
					error: new Error(`Invalid Step settings file ${path}: ${current.error.message}`),
				});
				return;
			}
			const next = { ...(current.value ?? {}) };
			for (const [rawKey, value] of Object.entries(patch)) {
				const key = rawKey as keyof StepSettings;
				if (key in STEP_SETTING_ALIASES) removeStepSettingAliases(next, key);
				if (value === undefined) delete next[rawKey];
				else next[rawKey] = clone(value);
			}
			if (path.endsWith(".toml")) writeStepConfig(path, { ...readStepConfig(path), ...next });
			else writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			if (scope === "global") this.global = next;
			else this.project = next;
		} catch (error) {
			this.errors.push({
				scope,
				path,
				error: new Error(
					`Could not persist Step settings ${path}: ${error instanceof Error ? error.message : String(error)}`,
				),
			});
		} finally {
			release?.();
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
				lastError = error;
				const started = Date.now();
				while (Date.now() - started < delayMs) {
					// Keep the synchronous setter API while waiting for a peer writer.
				}
			}
		}
		throw (lastError as Error) ?? new Error("Failed to acquire Step settings lock");
	}
}

class StepSettingsDecorator {
	private readonly pi: SettingsManager;
	private readonly store: StepSettingsStore;

	constructor(pi: SettingsManager, options: StepSettingsDecoratorOptions = {}) {
		this.pi = pi;
		const projectTrusted = options.projectTrusted ?? pi.isProjectTrusted();
		this.store = new StepSettingsStore(derivePaths(options), projectTrusted);
	}

	getPiSettingsManager(): SettingsManager {
		return this.pi;
	}

	getStepSettings(): StepSettings {
		// Canonicalize each scope before applying project precedence. Otherwise a
		// global canonical field (for example `feedbackEnabled`) survives the raw
		// object merge and outranks the equivalent project alias
		// (`feedback.enabled`) during normalization.
		return {
			...normalizeSettings(this.store.getGlobal()),
			...normalizeSettings(this.store.getProject()),
		};
	}

	getStepGlobalSettings(): StepSettings {
		return normalizeSettings(this.store.getGlobal());
	}

	getStepProjectSettings(): StepSettings {
		return normalizeSettings(this.store.getProject());
	}

	getStepSettingsPaths(): StepSettingsPaths {
		return this.store.getPaths();
	}

	setStepSettings(settings: Partial<StepSettings>): void {
		this.store.setGlobal(validatePatch(settings));
	}

	setProjectStepSettings(settings: Partial<StepSettings>): void {
		this.store.setProject(validatePatch(settings));
	}

	setEffectiveStepSettings(settings: Partial<StepSettings>): void {
		validatePatch(settings);
		const projectPatch: Partial<StepSettings> = {};
		const globalPatch: Partial<StepSettings> = {};
		for (const [key, value] of Object.entries(settings) as Array<
			[keyof StepSettings, StepSettings[keyof StepSettings]]
		>) {
			const overriddenByProject = this.store.hasProjectSetting(key);
			if (overriddenByProject) (projectPatch as Record<string, unknown>)[key] = value;
			else (globalPatch as Record<string, unknown>)[key] = value;
		}
		if (Object.keys(globalPatch).length > 0) this.setStepSettings(globalPatch);
		if (Object.keys(projectPatch).length > 0) this.setProjectStepSettings(projectPatch);
	}

	getStepPermissionPreset(): StepPermissionPresetId | undefined {
		return this.getStepSettings().permissionPreset;
	}

	setStepPermissionPreset(preset: StepPermissionPresetId): void {
		const normalized = getStepPermissionPreset(preset)?.id;
		if (!normalized) throw new Error(`Invalid Step permission preset: ${String(preset)}`);
		this.setEffectiveStepSettings({ permissionPreset: normalized });
	}

	getStepApprovalMode(): StepPermissionMode | undefined {
		return this.getStepSettings().approvalMode;
	}

	setStepApprovalMode(mode: StepPermissionMode | undefined): void {
		if (mode !== undefined && mode !== "confirm" && mode !== "strict" && mode !== "auto") {
			throw new Error(`Invalid Step approval mode: ${String(mode)}`);
		}
		this.setEffectiveStepSettings({ approvalMode: mode });
	}

	getStepNonInteractiveApproval(): StepNonInteractiveApproval | undefined {
		return this.getStepSettings().nonInteractiveApproval;
	}

	setStepNonInteractiveApproval(mode: StepNonInteractiveApproval | undefined): void {
		if (mode !== undefined && mode !== "allow" && mode !== "deny") {
			throw new Error(`Invalid Step non-interactive approval: ${String(mode)}`);
		}
		this.setEffectiveStepSettings({ nonInteractiveApproval: mode });
	}

	getStepAutoResume(): boolean | undefined {
		return this.getStepSettings().autoResume;
	}

	setStepAutoResume(enabled: boolean | undefined): void {
		if (enabled !== undefined && typeof enabled !== "boolean") {
			throw new Error(`Invalid Step autoResume setting: ${String(enabled)}`);
		}
		this.setEffectiveStepSettings({ autoResume: enabled });
	}

	setProjectTrusted(trusted: boolean): void {
		this.pi.setProjectTrusted(trusted);
		this.store.setProjectTrusted(trusted);
	}

	async reload(): Promise<void> {
		await this.pi.reload();
		this.store.reload();
	}

	async flush(): Promise<void> {
		await this.pi.flush();
	}

	drainErrors(): Array<ReturnType<SettingsManager["drainErrors"]>[number]> {
		const piErrors = this.pi.drainErrors();
		const sidecarErrors = this.store.drainErrors();
		return [...piErrors, ...sidecarErrors];
	}
}

/** Decorate an existing Pi manager with Step-only settings. */
export function decorateStepSettingsManager(
	pi: SettingsManager,
	options: StepSettingsDecoratorOptions = {},
): StepSettingsManager {
	const decorator = new StepSettingsDecorator(pi, options);
	const overrides = new Set<PropertyKey>([
		"getPiSettingsManager",
		"getStepSettings",
		"getStepGlobalSettings",
		"getStepProjectSettings",
		"getStepSettingsPaths",
		"setStepSettings",
		"setProjectStepSettings",
		"setEffectiveStepSettings",
		"getStepPermissionPreset",
		"setStepPermissionPreset",
		"getStepApprovalMode",
		"setStepApprovalMode",
		"getStepNonInteractiveApproval",
		"setStepNonInteractiveApproval",
		"getStepAutoResume",
		"setStepAutoResume",
		"setProjectTrusted",
		"reload",
		"flush",
		"drainErrors",
	]);
	return new Proxy(pi, {
		get(target, property) {
			if (overrides.has(property)) {
				const value = Reflect.get(decorator, property, decorator);
				return typeof value === "function" ? value.bind(decorator) : value;
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		has(target, property) {
			return overrides.has(property) || Reflect.has(target, property);
		},
	}) as StepSettingsManager;
}

/** Create a Pi manager and decorate it with Step's sidecar settings. */
export function createStepSettingsManager(
	cwd: string,
	agentDir?: string,
	options: StepSettingsManagerCreateOptions = {},
): StepSettingsManager {
	const resolvedAgentDir = resolve(options.agentDir ?? agentDir ?? resolveStepAgentDir());
	// Both halves of the manager must address the same document. Deriving the
	// paths once and handing them to the storage keeps an injected agent or
	// config directory from splitting Pi settings and Step settings across files.
	const decoratorOptions: StepSettingsDecoratorOptions = { ...options, cwd, agentDir: resolvedAgentDir };
	const paths = derivePaths(decoratorOptions);
	const pi = SettingsManager.fromStorage(new StepTomlSettingsStorage(cwd, process.env, paths), {
		projectTrusted: options.projectTrusted,
	});
	return decorateStepSettingsManager(pi, { ...decoratorOptions, paths });
}
