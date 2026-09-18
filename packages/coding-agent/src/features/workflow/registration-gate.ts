import { isIsolatedVmAvailable } from "./vm.ts";

function envFlag(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "on";
}

/**
 * Shared registration gate for the workflow tool and any extension layered on
 * top of it (e.g. ultraloop-opt-in). Consumers should call this instead of
 * duplicating the predicate so the two gates cannot drift. Kept in its own
 * leaf module so callers do not pull the full workflow runtime chain just to
 * check the gate.
 */
export function isWorkflowRegistrationEnabled(options: { enabled?: boolean; vmExecutor?: unknown } = {}): boolean {
	const enabled = options.enabled === true || envFlag(process.env.STEP_ENABLE_WORKFLOW);
	if (!enabled) return false;
	if (envFlag(process.env.STEP_DISABLE_WORKFLOW)) return false;
	if (!isIsolatedVmAvailable() && !options.vmExecutor) return false;
	return true;
}
