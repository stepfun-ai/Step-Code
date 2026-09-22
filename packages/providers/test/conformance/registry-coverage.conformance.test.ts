// Registry-coverage conformance (design §5.13): every kept dialect must be
// resolvable THROUGH the shared dialect registry, keyed strictly by `model.api`.
// This exercises the S5-3 registry facade over the live `getApiProvider` lookup
// and proves dispatch is by wire protocol, not provider identity.

import { describe, expect, it } from "vitest";
import type { ModelApiDialect } from "../../src/dialect/types.ts";
import { conformanceRegistry, resolveAdapter } from "./harness.ts";

// The full KnownApi set (the 3 concrete dialects that survive the strip).
const ALL_DIALECTS: ModelApiDialect[] = ["openai-completions", "openai-responses", "anthropic-messages"];

describe("dialect registry coverage", () => {
	it.each(ALL_DIALECTS)("resolves an adapter for %s strictly by dialect", (api) => {
		const adapter = resolveAdapter(api);
		// Adapter self-reports the dialect it was keyed by, and exposes the stream surface.
		expect(adapter.api).toBe(api);
		expect(typeof adapter.stream).toBe("function");
		expect(typeof adapter.streamSimple).toBe("function");
		expect(conformanceRegistry.has(api)).toBe(true);
	});

	it("returns undefined for an unknown dialect", () => {
		expect(conformanceRegistry.get("not-a-real-dialect" as ModelApiDialect)).toBeUndefined();
		expect(conformanceRegistry.has("not-a-real-dialect" as ModelApiDialect)).toBe(false);
	});
});
