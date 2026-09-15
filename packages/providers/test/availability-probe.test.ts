import { describe, expect, it } from "vitest";
import { probeProviderAvailability } from "../src/availability/probe.ts";
import type { ProviderProfile } from "../src/provider/types.ts";

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
	return {
		id: "step",
		label: "StepFun",
		baseUrl: "https://api.stepfun.com",
		authRef: "STEP_API_KEY",
		catalog: [],
		...overrides,
	};
}

const clock = () => 1_700_000_000_000;

describe("probeProviderAvailability", () => {
	it("reports unconfigured when the authRef resolves no credential", async () => {
		const result = await probeProviderAvailability(
			profile(),
			() => undefined,
			async () => {
				throw new Error("should not probe when unconfigured");
			},
			clock,
		);
		expect(result).toEqual({ state: "unconfigured" });
	});

	it("reports connected when the credential is present and the probe succeeds", async () => {
		const result = await probeProviderAvailability(
			profile(),
			() => "sk-secret-123",
			async () => {},
			clock,
		);
		expect(result).toEqual({ state: "connected", checkedAt: clock() });
	});

	it("reports error with the credential redacted from the reason", async () => {
		const credential = "sk-secret-123";
		const result = await probeProviderAvailability(
			profile(),
			() => credential,
			async () => {
				throw new Error(`401 Unauthorized for key ${credential}`);
			},
			clock,
		);
		expect(result.state).toBe("error");
		if (result.state !== "error") throw new Error("unreachable");
		expect(result.reason).not.toContain(credential);
		expect(result.reason).toContain("[redacted]");
		expect(result.reason).toContain("401 Unauthorized");
		expect(result.checkedAt).toBe(clock());
	});
});
