import { InMemoryCredentialStore } from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

/**
 * The StepCode is StepFun-only: when running under the Step entrypoint, the
 * runtime must NOT seed the default anthropic/openai builtin providers (their
 * claude and gpt catalogs would otherwise leak into the model selector). The
 * `includeDefaultBuiltins` option is the deterministic seam for that behavior;
 * its default derives from STEP_ENTRYPOINT in production. See model-runtime.ts.
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

	it("keeps anthropic/openai when includeDefaultBuiltins is true (plain pi / SDK)", async () => {
		const ids = await providerIds(true);
		expect(ids.has("anthropic")).toBe(true);
		expect(ids.has("openai")).toBe(true);
	});

	// The default is `!STEP_ENTRYPOINT`. Vitest runs without the Step entrypoint
	// signal, so the option-less default must seed the builtins (the non-step
	// branch). The step branch (STEP_ENTRYPOINT set => omitted) is covered
	// end-to-end by `step --list-models`, which shows only StepFun models.
	it("defaults to seeding builtins outside the Step entrypoint", async () => {
		const ids = await defaultProviderIds();
		expect(ids.has("anthropic")).toBe(true);
		expect(ids.has("openai")).toBe(true);
	});
});
