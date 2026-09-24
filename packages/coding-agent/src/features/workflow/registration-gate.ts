function envFlag(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "on";
}

export type WorkflowRegistrationDecision =
	| { enabled: true }
	| { enabled: false; reason: "not-enabled" | "disabled-by-env" };

/**
 * Shared registration gate for the workflow tool and any extension layered on
 * top of it (e.g. ultraloop-opt-in). Consumers should call this instead of
 * duplicating the predicate so the two gates cannot drift. Kept in its own leaf
 * module so callers do not pull the full workflow runtime chain just to check
 * the gate.
 *
 * Registration is on by default and now depends only on explicit opt-outs. The
 * sandbox is QuickJS compiled to WebAssembly (see `vm.ts`); it ships with the
 * package and runs on every supported runtime, so no environment can take
 * workflows away any more. The V8-native `isolated-vm` used to — silently, on
 * every released executable, whose JavaScriptCore engine can never load it.
 *
 * A registered tool is only an environment capability; USAGE consent stays gated
 * per turn/session by the ultraloop opt-in. An embedder's `enabled: false` or
 * STEP_DISABLE_WORKFLOW=1 turns registration off; STEP_ENABLE_WORKFLOW is not
 * read.
 */
export function resolveWorkflowRegistration(options: { enabled?: boolean } = {}): WorkflowRegistrationDecision {
	if (envFlag(process.env.STEP_DISABLE_WORKFLOW)) return { enabled: false, reason: "disabled-by-env" };
	if (options.enabled === false) return { enabled: false, reason: "not-enabled" };
	return { enabled: true };
}

export function isWorkflowRegistrationEnabled(options: { enabled?: boolean } = {}): boolean {
	return resolveWorkflowRegistration(options).enabled;
}
