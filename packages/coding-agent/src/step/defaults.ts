/** Defaults and argument normalization for the Step product entrypoint. */

export const STEP_DEFAULT_PROVIDER = "step";
export const STEP_DEFAULT_MODEL = "step-5-preview";
export const STEP_DEFAULT_THEME = "step-blue";

/**
 * Model ids owned by the Step provider.  Keep this list here (instead of
 * importing the provider extension) because argument defaults are evaluated
 * before extensions are loaded.  It also lets a migrated model selection be
 * routed back to Step when an older config left a different provider as the
 * persisted default.
 */
const STEP_MODEL_IDS = new Set([
	"step-5-preview",
	"step-3.7-flash",
	"step-3.5-flash-2603",
	"step-3.5-flash",
	"step-router-v1",
]);

/**
 * Defaults already persisted by Pi (or projected from the legacy Step
 * config).  These are deliberately passed in by the composition root instead
 * of being read here: `withStepDefaults()` runs before project trust has been
 * resolved, so it must not inspect untrusted project files itself.
 *
 * Both spellings are accepted because the migration report uses the
 * `default*` names while callers that mirror Pi's settings commonly use the
 * shorter `provider`/`model` names.
 */
export interface StepPersistedDefaults {
	provider?: string;
	model?: string;
	defaultProvider?: string;
	defaultModel?: string;
}

/**
 * Controls how the product launcher supplies implicit defaults.
 *
 * `deferSettingsSelection` leaves an invocation without explicit provider or
 * model flags untouched so the runtime can apply project settings first. The
 * regular helper keeps its historical eager-argv behavior for embedders that
 * rely on the returned argument list.
 */
export interface StepDefaultsOptions {
	deferSettingsSelection?: boolean;
}

const FALSE_ENV_VALUES = new Set(["0", "false", "off", "no"]);

// These commands are handled before the normal session parser. Keep their
// argv intact so pi can recognize the command at position zero (notably
// `auth`, which otherwise would be mistaken for an initial prompt).
const PACKAGE_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth"]);

/**
 * Add Step's provider/model defaults while preserving every explicit pi flag.
 * Package-management commands are passed through because they do not create a
 * session and must retain pi's command semantics.
 */
export function withStepDefaults(
	args: readonly string[],
	env: Record<string, string | undefined> = process.env,
	persisted?: StepPersistedDefaults,
	options: StepDefaultsOptions = {},
): string[] {
	const first = args[0];
	if (first !== undefined && PACKAGE_COMMANDS.has(first)) {
		// `main()` recognizes a bare `auth` invocation (and its help forms)
		// before parsing a provider. Keep those arguments intact; injecting the
		// Step provider would turn `step auth` into the invalid subcommand
		// `auth --provider step`.
		if (
			first === "auth" &&
			(args.length === 1 || args[1] === "help" || args.includes("--help") || args.includes("-h"))
		) {
			return [...args];
		}
		return first === "auth" ? withAuthDefaults(args, getStepDefaultProvider(env)) : [...args];
	}

	const persistedProvider = normalizeDefault(persisted?.provider ?? persisted?.defaultProvider);
	const persistedModel = normalizeDefault(persisted?.model ?? persisted?.defaultModel);
	const resolvedProvider = resolveProviderDefault(env, persistedProvider);
	const model = resolveModelDefault(env, persistedModel);
	const explicitEnvModel = isExplicitModelEnv(env, persistedModel);
	const result = [...args];
	const explicitProvider = readOptionValue(result, "--provider");
	const explicitModel = readOptionValue(result, "--model");
	const hasExplicitProvider = explicitProvider !== undefined || hasExplicitProviderEnvironment(env);
	// A bare Step model is unambiguous in the product CLI.  Migration can leave
	// models-proxy as the old default provider, but sending `step-3.7-flash` to
	// that provider produces a misleading 404.  Explicit CLI/env provider
	// choices still win, including an intentional models-proxy selection.
	const provider =
		!hasExplicitProvider && (isStepModelReference(explicitModel) || isStepModelReference(persistedModel))
			? STEP_DEFAULT_PROVIDER
			: resolvedProvider;
	const shouldRepairPersistedStepModel =
		!hasSessionRestoreSelector(result) &&
		isStepModelReference(persistedModel) &&
		persistedProvider !== STEP_DEFAULT_PROVIDER;
	if (
		options.deferSettingsSelection &&
		explicitProvider === undefined &&
		explicitModel === undefined &&
		!hasOption(result, "--models") &&
		!hasExplicitEnvironmentSelection(env) &&
		!shouldRepairPersistedStepModel
	) {
		// Project settings are loaded only after trust is resolved. Keep implicit
		// defaults out of argv so a trusted workspace can override global values.
		return result;
	}
	// Session selectors restore the model persisted in the selected session. Do
	// not turn a product default into an explicit CLI override for those calls;
	// that would make `step --continue` behave differently from pi. An explicit
	// provider/model still wins and is handled by the normal logic below.
	if (
		hasSessionRestoreSelector(result) &&
		explicitProvider === undefined &&
		!hasOption(result, "--model") &&
		!hasOption(result, "--models")
	) {
		return result;
	}
	// Leave a qualified model reference (for example `openai/gpt-4o`) to pi's
	// resolver. Supplying a default provider alongside it changes the meaning to
	// `step/openai/gpt-4o` and makes an otherwise valid cross-provider selection
	// fail. Bare model ids still get Step's default provider.
	if (explicitProvider === undefined && !hasQualifiedModelReference(result)) {
		result.unshift("--provider", provider);
	}
	const selectedProvider = explicitProvider ?? provider;
	if (
		explicitModel === undefined &&
		!hasOption(result, "--model") &&
		!hasOption(result, "--models") &&
		shouldInjectModel(selectedProvider, persistedProvider, persistedModel, explicitEnvModel)
	) {
		const endOfOptions = result.indexOf("--");
		const insertionIndex = endOfOptions === -1 ? result.length : endOfOptions;
		result.splice(insertionIndex, 0, "--model", model);
	}
	return result;
}

function hasExplicitEnvironmentSelection(env: Record<string, string | undefined>): boolean {
	const provider = normalizeDefault(env.STEP_PROVIDER ?? env.STEP_MODEL_PROVIDER);
	const model = normalizeDefault(env.STEP_MODEL);
	if (provider || model) return true;
	// applyStepEnvironment seeds these legacy names with the Step fallback. A
	// different value is an explicit user override; the fallback itself remains
	// deferred to SettingsManager/runtime selection.
	return (
		(Boolean(normalizeDefault(env.STEPCODE_DEFAULT_PROVIDER)) &&
			normalizeDefault(env.STEPCODE_DEFAULT_PROVIDER) !== STEP_DEFAULT_PROVIDER) ||
		(Boolean(normalizeDefault(env.STEPCODE_DEFAULT_MODEL)) &&
			normalizeDefault(env.STEPCODE_DEFAULT_MODEL) !== STEP_DEFAULT_MODEL)
	);
}

function hasExplicitProviderEnvironment(env: Record<string, string | undefined>): boolean {
	if (normalizeDefault(env.STEP_PROVIDER ?? env.STEP_MODEL_PROVIDER)) return true;
	const legacy = normalizeDefault(env.STEPCODE_DEFAULT_PROVIDER);
	return Boolean(legacy && legacy !== STEP_DEFAULT_PROVIDER);
}

function isStepModelReference(value: string | undefined): boolean {
	if (!value) return false;
	const model = value.trim().toLowerCase();
	if (!model) return false;
	const base = model.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/u, "");
	return STEP_MODEL_IDS.has(base);
}

/** Add the product provider to auth commands that do not identify a model/provider. */
function withAuthDefaults(args: readonly string[], provider: string): string[] {
	const commandArgs = args.slice(2);
	if (
		readOptionValue(commandArgs, "--provider") !== undefined ||
		readOptionValue(commandArgs, "--model") !== undefined
	) {
		return [...args];
	}

	const delimiter = commandArgs.indexOf("--");
	const insertionIndex = delimiter === -1 ? commandArgs.length : delimiter;
	return [
		...args.slice(0, 2),
		...commandArgs.slice(0, insertionIndex),
		"--provider",
		provider,
		...commandArgs.slice(insertionIndex),
	];
}

/** Resolve the provider used by the Step entrypoint and its help text. */
export function getStepDefaultProvider(env: Record<string, string | undefined> = process.env): string {
	return (
		env.STEP_PROVIDER?.trim() ||
		env.STEP_MODEL_PROVIDER?.trim() ||
		env.STEPCODE_DEFAULT_PROVIDER?.trim() ||
		STEP_DEFAULT_PROVIDER
	);
}

/** Resolve the model used by the Step entrypoint and its help text. */
export function getStepDefaultModel(env: Record<string, string | undefined> = process.env): string {
	return env.STEP_MODEL?.trim() || env.STEPCODE_DEFAULT_MODEL?.trim() || STEP_DEFAULT_MODEL;
}

/** Resolve the default theme setting used by the Step entrypoint. */
export function getStepDefaultTheme(env: Record<string, string | undefined> = process.env): string {
	return env.STEPCODE_DEFAULT_THEME?.trim() || STEP_DEFAULT_THEME;
}

function normalizeDefault(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

/**
 * Resolve a provider default according to `explicit env > persisted > Step
 * fallback`. `applyStepEnvironment()` seeds `STEPCODE_DEFAULT_PROVIDER` with
 * the Step fallback for compatibility; when a persisted value is supplied,
 * that seeded value is treated as implicit rather than as a user override.
 */
function resolveProviderDefault(
	env: Record<string, string | undefined>,
	persistedProvider: string | undefined,
): string {
	const explicit = normalizeDefault(env.STEP_PROVIDER ?? env.STEP_MODEL_PROVIDER);
	if (explicit) return explicit;
	const legacy = normalizeDefault(env.STEPCODE_DEFAULT_PROVIDER);
	if (legacy && !(legacy === STEP_DEFAULT_PROVIDER && persistedProvider)) return legacy;
	return persistedProvider ?? STEP_DEFAULT_PROVIDER;
}

/** See {@link resolveProviderDefault} for the legacy env compatibility rule. */
function resolveModelDefault(env: Record<string, string | undefined>, persistedModel: string | undefined): string {
	const explicit = normalizeDefault(env.STEP_MODEL);
	if (explicit) return explicit;
	const legacy = normalizeDefault(env.STEPCODE_DEFAULT_MODEL);
	if (legacy && !(legacy === STEP_DEFAULT_MODEL && persistedModel)) return legacy;
	return persistedModel ?? STEP_DEFAULT_MODEL;
}

/**
 * Persisted model values are only carried across when they belong to the
 * provider that will actually be selected. This prevents an env-selected
 * provider from accidentally receiving a model id from another provider.
 */
function shouldInjectModel(
	selectedProvider: string,
	persistedProvider: string | undefined,
	persistedModel: string | undefined,
	explicitEnvModel: boolean,
): boolean {
	if (explicitEnvModel) return true;
	if (selectedProvider === STEP_DEFAULT_PROVIDER && isStepModelReference(persistedModel)) return true;
	if (persistedModel && (!persistedProvider || selectedProvider === persistedProvider)) return true;
	return selectedProvider === STEP_DEFAULT_PROVIDER;
}

function isExplicitModelEnv(env: Record<string, string | undefined>, persistedModel: string | undefined): boolean {
	if (normalizeDefault(env.STEP_MODEL)) return true;
	const legacy = normalizeDefault(env.STEPCODE_DEFAULT_MODEL);
	return Boolean(legacy && !(legacy === STEP_DEFAULT_MODEL && persistedModel));
}

/** Whether the Step launcher should disable Pi's optional background services. */
export function isStepServicesDisabled(env: Record<string, string | undefined> = process.env): boolean {
	const value = env.STEPCODE_DISABLE_PI_SERVICES?.trim().toLowerCase();
	return value !== undefined && !FALSE_ENV_VALUES.has(value);
}

function hasQualifiedModelReference(args: readonly string[]): boolean {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") return false;
		if (arg === "--model") {
			if (args[index + 1]?.includes("/")) return true;
			index += 1;
			continue;
		}
		if (arg.startsWith("--model=") && arg.slice("--model=".length).includes("/")) return true;
	}
	return false;
}

function hasOption(args: readonly string[], name: string): boolean {
	for (const arg of args) {
		if (arg === "--") return false;
		if (arg === name || arg.startsWith(`${name}=`)) return true;
	}
	return false;
}

function readOptionValue(args: readonly string[], name: string): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") return undefined;
		if (arg === name) return args[index + 1];
		if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
	}
	return undefined;
}

function hasSessionRestoreSelector(args: readonly string[]): boolean {
	for (const arg of args) {
		if (arg === "--") return false;
		if (
			arg === "--continue" ||
			arg === "-c" ||
			arg === "--resume" ||
			arg === "-r" ||
			arg === "--session" ||
			arg === "--fork"
		) {
			return true;
		}
	}
	return false;
}
