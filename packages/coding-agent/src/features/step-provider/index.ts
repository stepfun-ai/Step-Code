import {
	getStepOAuthApiKey,
	loginStepOAuth,
	normalizeStepModel,
	normalizeStepModelConfig,
	type ResolvedStepProviderOptions,
	refreshStepOAuth,
	resolveStepProviderOptions,
	type StepProviderOptions,
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
	return {
		name: resolved.name,
		baseUrl: resolved.apiBaseUrl,
		apiKey: `$${resolved.apiKeyEnv}`,
		api: "anthropic-messages",
		// The built-in catalog is a default; keep custom models migrated from
		// the legacy Step CLI layout (and later user additions) in this provider.
		mergeModelsJson: true,
		// models.json is user-owned and can outlive the provider defaults. Normalize
		// the final composed list as a last line of defense for embedded hosts that
		// do not run Step's startup migration first.
		normalizeModels: (models) => models.map((model) => normalizeStepModel(model, resolved.apiBaseUrl)),
		models: resolved.models.map((model) => normalizeStepModelConfig(model)),
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
