import { describe, expect, it } from "vitest";
import { deriveFromLegacyProvider, resolveModelApiDialect } from "../src/dialect/resolve.ts";
import type { ProviderProfile } from "../src/provider/types.ts";

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
	return {
		id: "anthropic",
		label: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		authRef: "ANTHROPIC_API_KEY",
		catalog: [],
		...overrides,
	};
}

describe("resolveModelApiDialect", () => {
	it("prefers an explicit model.api over a profile default that would derive differently", () => {
		const resolved = resolveModelApiDialect(
			{ api: "openai-responses", provider: "anthropic" },
			profile({ defaultApi: "anthropic-messages" }),
		);
		expect(resolved).toEqual({ api: "openai-responses", source: "declared" });
	});

	it("derives from the profile default when the model omits api", () => {
		const resolved = resolveModelApiDialect({ provider: "anthropic" }, profile({ defaultApi: "anthropic-messages" }));
		expect(resolved).toEqual({ api: "anthropic-messages", source: "derived-from-provider" });
	});

	it("returns undefined when neither an explicit api nor a profile default is present", () => {
		// Mirrors provider-composer.ts throwing on a missing api rather than guessing
		// from the provider name — the caller raises the configuration error.
		const resolved = resolveModelApiDialect({ provider: "anthropic" }, profile());
		expect(resolved).toBeUndefined();
	});
});

describe("deriveFromLegacyProvider", () => {
	it("derives nothing today — there is no faithful provider-name -> single-dialect mapping", () => {
		expect(deriveFromLegacyProvider("anthropic")).toBeUndefined();
		expect(deriveFromLegacyProvider("openai")).toBeUndefined();
		expect(deriveFromLegacyProvider("unknown-provider")).toBeUndefined();
		expect(deriveFromLegacyProvider("some-unknown-provider")).toBeUndefined();
	});
});
