import type { ProviderProfile } from "../provider/types.ts";

// —— S5-7: provider availability tri-state ——
//
// Answers the user's most common question — "why can't I select this model?" — by
// attaching a tri-state to a catalog entry. This is an ADDITIVE, pure helper: the
// live product-side refresh (coding-agent model-runtime.refreshProviderAvailability)
// remains the runtime source of truth; this gives packages/providers the S5-7 vocabulary
// and a dependency-injected probe that the product can back onto without a second
// availability source. Design §5.8.

export type ProviderAvailability =
	| { state: "unconfigured" } // no credential resolved from the profile's authRef
	| { state: "connected"; checkedAt: number } // credential present, probe succeeded
	| { state: "error"; reason: string; checkedAt: number }; // credential present, probe failed

/** Resolves a profile's credential (from its `authRef`), or undefined if unconfigured. */
export type CredentialResolver = (authRef: string) => Promise<string | undefined> | string | undefined;

/** Performs the connectivity probe for a configured profile; throws on failure. */
export type ProbeRequest = (profile: ProviderProfile, credential: string) => Promise<void>;

/**
 * Redact a resolved credential from an error reason so `error.reason` (and any
 * telemetry built from it) never carries the secret in plaintext (§5.14 condition 5).
 */
function redactCredential(reason: string, credential: string): string {
	if (!credential) return reason;
	return reason.split(credential).join("[redacted]");
}

/**
 * Tri-state availability probe (§5.8): 1) authRef resolves nothing -> `unconfigured`;
 * 2) credential present and the probe succeeds -> `connected`; 3) credential present
 * and the probe throws -> `error` (reason with the credential redacted). The probe and
 * clock are injected so this stays pure and network-free for tests; callers pass the
 * real credential resolver + connectivity check. It is async and must not block startup.
 */
export async function probeProviderAvailability(
	profile: ProviderProfile,
	resolveCredential: CredentialResolver,
	sendProbe: ProbeRequest,
	now: () => number = () => Date.now(),
): Promise<ProviderAvailability> {
	const credential = await resolveCredential(profile.authRef);
	if (!credential) return { state: "unconfigured" };
	try {
		await sendProbe(profile, credential);
		return { state: "connected", checkedAt: now() };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { state: "error", reason: redactCredential(message, credential), checkedAt: now() };
	}
}
