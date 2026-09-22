import { describe, expect, it } from "vitest";
import { createDialectRegistry } from "../src/dialect/registry.ts";
import { createProviderRegistry } from "../src/provider/registry.ts";
import type { ProviderProfile } from "../src/provider/types.ts";

describe("createDialectRegistry", () => {
	// The registry is a thin wrapper over an injected api -> adapter lookup; it must
	// not add behavior beyond delegating, so a fake stands in for the real byApi /
	// getApiProvider source.
	const adapters: Record<string, { tag: string }> = {
		"anthropic-messages": { tag: "anthropic" },
		"openai-completions": { tag: "openai" },
	};
	const registry = createDialectRegistry(
		(api) => adapters[api],
		() => ["anthropic-messages", "openai-completions"],
	);

	it("resolves an adapter strictly by dialect (model.api)", () => {
		expect(registry.get("anthropic-messages")).toEqual({ tag: "anthropic" });
		expect(registry.get("openai-completions")).toEqual({ tag: "openai" });
	});

	it("reports has() and returns undefined for an unregistered dialect", () => {
		expect(registry.has("anthropic-messages")).toBe(true);
		expect(registry.has("openai-responses")).toBe(false);
		expect(registry.get("openai-responses")).toBeUndefined();
	});

	it("enumerates dialects from the injected source, defaulting to empty", () => {
		expect(registry.dialects()).toEqual(["anthropic-messages", "openai-completions"]);
		expect(createDialectRegistry(() => undefined).dialects()).toEqual([]);
	});
});

describe("createProviderRegistry", () => {
	const profiles: Record<string, ProviderProfile> = {
		anthropic: { id: "anthropic", label: "Anthropic", baseUrl: "https://a", authRef: "A", catalog: [] },
	};
	const registry = createProviderRegistry(
		(id) => profiles[id],
		() => ["anthropic"],
	);

	it("resolves identity by profile id and never exposes a dialect selector", () => {
		expect(registry.get("anthropic")?.label).toBe("Anthropic");
		expect(registry.has("anthropic")).toBe(true);
		expect(registry.has("openai")).toBe(false);
		expect(registry.get("openai")).toBeUndefined();
		expect(registry.ids()).toEqual(["anthropic"]);
	});
});
