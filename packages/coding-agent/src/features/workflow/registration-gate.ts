import { isIsolatedVmAvailable, isIsolatedVmHostable } from "./vm.ts";

function envFlag(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "on";
}

export type WorkflowRegistrationDecision =
	| { enabled: true }
	| { enabled: false; reason: "not-enabled" | "disabled-by-env" | "vm-unavailable" };

/**
 * Startup warning for the one refusal that contradicts the default-on
 * registration: every other reason honors an explicit "off" or a runtime that
 * has a working executor anyway.
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
 *
 * A runtime that cannot host isolated-vm is not a refusal. The V8-native addon
 * never loads on the shipped executable's JavaScriptCore engine, so that host
 * runs workflows through the bundled QuickJS WebAssembly executor instead (see
 * `vm-quickjs.ts`) and registers normally. Only a V8 host whose addon failed to
 * load is a real, fixable gap — that one warns.
 */
export function resolveWorkflowRegistration(
	options: { enabled?: boolean; vmExecutor?: unknown } = {},
	vmAvailable: boolean = isIsolatedVmAvailable(),
	vmHostable: boolean = isIsolatedVmHostable(),
): WorkflowRegistrationDecision {
	if (envFlag(process.env.STEP_DISABLE_WORKFLOW)) return { enabled: false, reason: "disabled-by-env" };
	if (options.enabled === false) return { enabled: false, reason: "not-enabled" };
	if (!vmAvailable && !options.vmExecutor) {
		// Non-V8 host: QuickJS stands in for isolated-vm, so workflows are available.
		if (!vmHostable) return { enabled: true };
		return { enabled: false, reason: "vm-unavailable" };
	}
	return { enabled: true };
}

export function isWorkflowRegistrationEnabled(options: { enabled?: boolean; vmExecutor?: unknown } = {}): boolean {
	return resolveWorkflowRegistration(options).enabled;
}
