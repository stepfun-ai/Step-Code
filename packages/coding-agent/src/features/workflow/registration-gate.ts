import { isIsolatedVmAvailable, isIsolatedVmHostable } from "./vm.ts";

function envFlag(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "on";
}

export type WorkflowRegistrationDecision =
	| { enabled: true }
	| { enabled: false; reason: "not-enabled" | "disabled-by-env" | "vm-unavailable" | "vm-unsupported-runtime" };

/**
 * Startup warning for the one refusal that contradicts the default-on
 * registration: every other reason honors an explicit "off" or an unfixable
 * runtime fact and stays silent.
 */
export const WORKFLOW_VM_UNAVAILABLE_WARNING =
	"Workflow tools are unavailable this session: the isolated-vm native module failed to load. Rebuild or reinstall isolated-vm to restore the workflow tool, /workflows, and /ultraloop, or set STEP_DISABLE_WORKFLOW=1 to silence this warning.";

/**
 * Shared registration gate for the workflow tool and any extension layered on
 * top of it (e.g. ultraloop-opt-in). Consumers should call this instead of
 * duplicating the predicate so the two gates cannot drift. Kept in its own
 * leaf module so callers do not pull the full workflow runtime chain just to
 * check the gate. Returns the refusal reason so the workflow extension can
 * warn when the default-on registration degrades, instead of silently
 * registering nothing.
 *
 * Registration is on by default, matching Claude Code: a registered tool is an
 * environment capability, and USAGE consent stays gated per turn/session by
 * the ultraloop opt-in. An embedder's `enabled: false` or
 * STEP_DISABLE_WORKFLOW=1 turns registration off; STEP_ENABLE_WORKFLOW is no
 * longer read.
 */
export function resolveWorkflowRegistration(
	options: { enabled?: boolean; vmExecutor?: unknown } = {},
	vmAvailable: boolean = isIsolatedVmAvailable(),
	vmHostable: boolean = isIsolatedVmHostable(),
): WorkflowRegistrationDecision {
	if (envFlag(process.env.STEP_DISABLE_WORKFLOW)) return { enabled: false, reason: "disabled-by-env" };
	if (options.enabled === false) return { enabled: false, reason: "not-enabled" };
	if (!vmAvailable && !options.vmExecutor) {
		// A missing native module is fixable on a V8 runtime (warn so the user can
		// reinstall it); on a non-V8 runtime it never loads, so refuse silently.
		return { enabled: false, reason: vmHostable ? "vm-unavailable" : "vm-unsupported-runtime" };
	}
	return { enabled: true };
}

export function isWorkflowRegistrationEnabled(options: { enabled?: boolean; vmExecutor?: unknown } = {}): boolean {
	return resolveWorkflowRegistration(options).enabled;
}
