import { isIsolatedVmAvailable } from "./vm.ts";

function envFlag(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "on";
}

export type WorkflowRegistrationDecision =
	| { enabled: true }
	| { enabled: false; reason: "not-enabled" | "disabled-by-env" | "vm-unavailable" };

/**
 * Startup warning for the one refusal that contradicts an explicit user "on":
 * every other reason honors an explicit or default "off" and stays silent.
 */
export const WORKFLOW_VM_UNAVAILABLE_WARNING =
	"Workflow tools are enabled (STEP_ENABLE_WORKFLOW) but unavailable this session: the isolated-vm native module failed to load. Rebuild or reinstall isolated-vm to restore the workflow tool, /workflows, and /ultraloop.";

/**
 * Shared registration gate for the workflow tool and any extension layered on
 * top of it (e.g. ultraloop-opt-in). Consumers should call this instead of
 * duplicating the predicate so the two gates cannot drift. Kept in its own
 * leaf module so callers do not pull the full workflow runtime chain just to
 * check the gate. Returns the refusal reason so the workflow extension can
 * warn when an explicitly enabled feature degrades, instead of silently
 * registering nothing.
 */
export function resolveWorkflowRegistration(
	options: { enabled?: boolean; vmExecutor?: unknown } = {},
	vmAvailable: boolean = isIsolatedVmAvailable(),
): WorkflowRegistrationDecision {
	const enabled = options.enabled === true || envFlag(process.env.STEP_ENABLE_WORKFLOW);
	if (!enabled) return { enabled: false, reason: "not-enabled" };
	if (envFlag(process.env.STEP_DISABLE_WORKFLOW)) return { enabled: false, reason: "disabled-by-env" };
	if (!vmAvailable && !options.vmExecutor) return { enabled: false, reason: "vm-unavailable" };
	return { enabled: true };
}

export function isWorkflowRegistrationEnabled(options: { enabled?: boolean; vmExecutor?: unknown } = {}): boolean {
	return resolveWorkflowRegistration(options).enabled;
}
