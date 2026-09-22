import {
	fetchStepModels,
	getStepOAuthApiKey,
	loginStepOAuth,
	normalizeStepModel,
	normalizeStepModelConfig,
	type ResolvedStepProviderOptions,
	refreshStepOAuth,
	resolveStepProviderOptions,
	type StepProviderOptions,
	stepOpenAiBaseUrl,
} from "@step-harness/providers/step-provider";
import type { ExtensionAPI, InlineExtension, ProviderConfig } from "../../core/extensions/types.ts";

// The Step provider's identity / OAuth / model-catalog core now lives in the providers
// layer (packages/providers/src/step-provider). Re-export it here so existing importers
// of this path keep working unchanged. The extension-registration glue below stays in the
// product package because it consumes coding-agent's ExtensionAPI / ProviderConfig, which
// belong to the extension system, not the neutral providers layer (§10.4 C8 split).
export * from "@step-harness/providers/step-provider";

/** Build the legacy provider config accepted by `pi.registerProvider()`. */
export function createStepProviderConfig(options: StepProviderOptions = {}): ProviderConfig {
	const resolved = resolveStepProviderOptions(options);
	return createStepProviderConfigFromResolved(resolved);
}

function createStepProviderConfigFromResolved(resolved: ResolvedStepProviderOptions): ProviderConfig {
	// All Step profile URLs speak OpenAI Chat Completions; discovery and chat
	// both use the `.../v1` base for the active profile.
	const openaiBaseUrl = stepOpenAiBaseUrl(resolved.apiBaseUrl);
	return {
		name: resolved.name,
		baseUrl: openaiBaseUrl,
		apiKey: `$${resolved.apiKeyEnv}`,
		api: "openai-completions",
		// The built-in catalog is an offline/pre-login baseline; keep custom models
		// migrated from the legacy StepCode layout (and later user additions).
		mergeModelsJson: true,
		// models.json is user-owned and can outlive the provider defaults. Normalize
		// the final composed list as a last line of defense for embedded hosts that
		// do not run Step's startup migration first.
		normalizeModels: (models) => models.map((model) => normalizeStepModel(model, openaiBaseUrl)),
		models: resolved.models.map((model) => normalizeStepModelConfig(model)),
		// After login, replace the baseline with the account's real usable models
		// discovered from `{base}/v1/models`.
		refreshModels: (context) => fetchStepModels(context, resolved),
		oauth: {
			name: "Step Plan",
			isSubscription: true,
			login: (callbacks) => loginStepOAuth(callbacks, resolved),
			refreshToken: (credentials, signal) => refreshStepOAuth(credentials, resolved, signal),
			getApiKey: getStepOAuthApiKey,
		},
	};
}

/** Register Step with pi's extension provider registry. */
export function registerStepProvider(
	pi: Pick<ExtensionAPI, "registerProvider">,
	options: StepProviderOptions = {},
): void {
	const resolved = resolveStepProviderOptions(options);
	pi.registerProvider(resolved.providerId, createStepProviderConfigFromResolved(resolved));
}

/** Default extension entry point, loadable with `pi -e`. */
export default function stepProviderExtension(pi: ExtensionAPI): void {
	registerStepProvider(pi);
}

/** Inline extension descriptor for applications that assemble pi's built-ins. */
export const stepProviderInlineExtension: InlineExtension = {
	name: "Step provider",
	factory: stepProviderExtension,
	hidden: true,
};

/** Create an inline extension with explicit provider settings (useful in tests/hosts). */
export function createStepProviderInlineExtension(options: StepProviderOptions = {}): InlineExtension {
	return {
		name: options.name ?? "Step provider",
		factory: (pi) => registerStepProvider(pi, options),
		hidden: true,
	};
}
