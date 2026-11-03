import type { ModelApiDialect } from "../dialect/types.ts";
import type { ProviderId } from "../types.ts";

/**
 * Identity of a provider profile — endpoint / auth / catalog / display name /
 * telemetry. This is the axis orthogonal to {@link ModelApiDialect}: identity
 * NEVER selects the protocol implementation.
 *
 * Aliased to the existing {@link ProviderId} rather than a bare `string` (the
 * design's §5.2 shorthand) so profiles tie into the identity type already used
 * across the codebase (`Model.provider: ProviderId`).
 */
export type ProviderProfileId = ProviderId;

/**
 * A provider's identity and directory. The protocol implementation is chosen by
 * `model.api`, NOT by anything on this profile. `defaultApi` is only a
 * compatibility default consumed by `resolveModelApiDialect` when a model omits
 * an explicit `api` — it is not a dispatch input.
 */
export interface ProviderProfile {
	id: ProviderProfileId;
	/** Display name. */
	label: string;
	/** Where to connect. */
	baseUrl: string;
	/** Which env var / credential the key is read from. */
	authRef: string;
	/** Directory: which model ids live under this profile. */
	catalog: string[];
	/** This profile's default dialect; individual model entries may override it. */
	defaultApi?: ModelApiDialect;
}
