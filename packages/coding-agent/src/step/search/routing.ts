import { KEYLESS_ADAPTERS } from "./adapters.ts";
import type { SearchCandidate, SearchChain, SearchChainMode } from "./types.ts";

export interface BuildSearchChainInput {
	readonly mode: SearchChainMode;
	/** Whether the Step login resolves a search credential for this call. */
	readonly hasStepCredential: boolean;
	/** Resolved StepFun search endpoint. The caller always resolves one. */
	readonly stepEndpoint: string;
	/** Injected for deterministic tests; defaults to `Math.random`. */
	readonly random?: () => number;
}

/** The StepFun search tool name; the endpoint differs per login profile. */
export const STEPFUN_SEARCH_TOOL_NAME = "web_search";

function fisherYates<T>(items: readonly T[], random: () => number): T[] {
	const shuffled = [...items];
	for (let index = shuffled.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(random() * (index + 1));
		const value = shuffled[index]!;
		shuffled[index] = shuffled[swap]!;
		shuffled[swap] = value;
	}
	return shuffled;
}

function keylessCandidates(random: () => number): SearchCandidate[] {
	return fisherYates(KEYLESS_ADAPTERS, random).map((adapter) => ({
		id: adapter.id,
		tier: "keyless",
		endpoint: adapter.endpoint,
		toolName: adapter.toolName,
		transport: adapter.transport,
		// Free endpoints are called statelessly; a refusal falls back to a handshake.
		allowHandshake: true,
		...(adapter.headers ? { headers: adapter.headers } : {}),
	}));
}

function stepfunCandidate(endpoint: string): SearchCandidate {
	return {
		id: "stepfun",
		tier: "stepfun",
		endpoint,
		toolName: STEPFUN_SEARCH_TOOL_NAME,
		transport: "mcp",
		// The StepFun endpoint is reached through the SDK client already.
		allowHandshake: false,
	};
}

/**
 * Build the ordered candidate list for one search.
 *
 * The paid tier is only present when a Step search credential actually resolves
 * for this call. An absent credential is not "try and fail": the free providers
 * are used directly, which skips a call that cannot succeed.
 *
 * Free providers are shuffled per call rather than fixed: every provider has its
 * own free allowance, so a fixed order would spend the first one's allowance on
 * all traffic and leave the rest idle. Shuffling spreads the load while the
 * chain still walks the list in order.
 */
export function buildSearchChain(input: BuildSearchChainInput): SearchChain {
	const random = input.random ?? Math.random;

	if (input.mode === "off") {
		return { candidates: [], disabled: true, skippedPaidTier: "disabled" };
	}

	if (input.mode === "step") {
		// Pinned to the paid backend. `stepEndpoint` is always resolved by the
		// caller, so the only thing that can be missing is the credential, which is
		// a configuration error rather than a reason to use another backend.
		if (!input.hasStepCredential) return { candidates: [], requiresCredential: true };
		return { candidates: [stepfunCandidate(input.stepEndpoint)] };
	}

	if (input.mode !== "auto") {
		const adapter = KEYLESS_ADAPTERS.find((entry) => entry.id === input.mode);
		if (!adapter) return { candidates: [], disabled: true };
		const [candidate] = keylessCandidates(random).filter((entry) => entry.id === adapter.id);
		return { candidates: candidate ? [candidate] : [] };
	}

	const free = keylessCandidates(random);
	if (input.hasStepCredential) {
		return { candidates: [stepfunCandidate(input.stepEndpoint), ...free] };
	}
	return { candidates: free, skippedPaidTier: "no-step-credential" };
}
