import { describe, expect, it } from "vitest";
import { getBuiltinModelDataGeneratedAt } from "../src/providers/all.ts";
import modelDataManifest from "../src/providers/data/.manifest.json" with { type: "json" };

describe("getBuiltinModelDataGeneratedAt", () => {
	it("returns the manifest generatedAt as epoch ms when the manifest exists", () => {
		// Regression guard: the refactor once hardcoded this to `undefined`, which
		// silently disabled the stale-catalog suppression gate in
		// remote-catalog-provider.ts for the anthropic/openai builtins. It must read
		// the tracked manifest timestamp so a stale remote overlay can be discarded.
		const value = getBuiltinModelDataGeneratedAt();
		expect(typeof value).toBe("number");
		expect(Number.isFinite(value)).toBe(true);
		expect(value).toBe(Date.parse(modelDataManifest.generatedAt));
	});
});
