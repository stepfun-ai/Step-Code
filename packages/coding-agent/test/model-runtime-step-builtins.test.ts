import { InMemoryCredentialStore } from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

/**
 * The provider catalog is Step-only: the runtime must not seed the removed
 * anthropic/openai builtins, regardless of the compatibility gating option.
 * The `includeDefaultBuiltins` option remains a deterministic seam for hosts
 * that supply a non-empty catalog; the generated Step catalog is intentionally
 * empty and the product registers Step separately.
 */
describe("ModelRuntime default builtins gating", () => {
	async function providerIds(includeDefaultBuiltins: boolean): Promise<Set<string>> {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
			includeDefaultBuiltins,
		});
		return new Set(runtime.getProviders().map((provider) => provider.id));
	}

	async function defaultProviderIds(): Promise<Set<string>> {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		return new Set(runtime.getProviders().map((provider) => provider.id));
	}

	it("omits anthropic/openai when includeDefaultBuiltins is false (StepCode)", async () => {
		const ids = await providerIds(false);
		expect(ids.has("anthropic")).toBe(false);
		expect(ids.has("openai")).toBe(false);
	});

	it("does not resurrect removed anthropic/openai builtins when enabled", async () => {
		const ids = await providerIds(true);
		expect(ids.has("anthropic")).toBe(false);
		expect(ids.has("openai")).toBe(false);
	});

	// The default is `!STEP_ENTRYPOINT`, but the generated catalog is empty in
	// both hosts. The Step entrypoint registers its dynamic provider separately.
	it("keeps the default catalog empty outside the Step entrypoint", async () => {
		const ids = await defaultProviderIds();
		expect(ids.has("anthropic")).toBe(false);
		expect(ids.has("openai")).toBe(false);
	});
});
