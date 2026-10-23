/** Step's built-in clarification, plan, task-tracking, and delegated-agent extensions. */

import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "../core/extensions/types.ts";
import type { StepTelemetryReporter } from "../step/telemetry.ts";
import { createStepCompactExtension } from "./compact.ts";
import { createStepPlanExtension } from "./step-plan.ts";
import { registerStepClarifyUserExtension } from "./step-questionnaire.ts";
import { createStepSubagentExtension, type StepSubagentExtensionOptions } from "./step-subagent.ts";
import { createStepTasksExtension } from "./step-tasks.ts";
import { registerWorkflowChildAcl } from "./workflow/acl-extension.ts";
import { createStepWorkflowExtension, type StepWorkflowExtensionOptions } from "./workflow/step-workflow.ts";
import { createUltraloopOptInExtension, type UltraloopTurnState } from "./workflow/ultraloop-opt-in.ts";

export interface StepCapabilitiesExtensionOptions {
	subagent?: StepSubagentExtensionOptions;
	/** Optional process reporter; capability adapters never own delivery. */
	telemetry?: StepTelemetryReporter;
	/** Workflow registers by default (Claude Code parity); `enabled: false` or STEP_DISABLE_WORKFLOW=1 turns it off. */
	workflow?: StepWorkflowExtensionOptions;
	/**
	 * Step CLI entry for subagent and workflow children. Hosts whose own entry is
	 * not the Step CLI (the Web server) must set it; the CLI can omit it.
	 */
	cliPath?: string;
	/**
	 * Whether this host exposes the session-standing ultraloop switch
	 * (`/ultraloop on|off`). Defaults to true (CLI). The Web/Desktop host offers
	 * per-turn opt-in only, so it passes false.
	 */
	ultraloopSessionMode?: boolean;
}

/** Compose Pi's native UI examples behind one Step-owned inline extension. */
export function createStepCapabilitiesExtension(options: StepCapabilitiesExtensionOptions = {}): ExtensionFactory {
	const compact = createStepCompactExtension();
	const plan = createStepPlanExtension({ telemetry: options.telemetry });
	const tasks = createStepTasksExtension();
	const subagent = createStepSubagentExtension({
		cliPath: options.cliPath,
		...options.subagent,
		telemetry: options.telemetry,
	});
	const workflowTurnState: UltraloopTurnState = {};
	const workflow = createStepWorkflowExtension({
		cliPath: options.cliPath,
		...options.workflow,
		telemetry: options.workflow?.telemetry ?? options.telemetry,
		turnState: workflowTurnState,
	});
	const ultraloopOptIn = createUltraloopOptInExtension({
		enabled: options.workflow?.enabled,
		vmExecutor: options.workflow?.vmExecutor,
		turnState: workflowTurnState,
		sessionMode: options.ultraloopSessionMode,
	});
	return (pi: ExtensionAPI): void => {
		registerWorkflowChildAcl(pi, options.telemetry);
		registerStepClarifyUserExtension(pi, options.telemetry);
		compact(pi);
		plan(pi);
		tasks(pi);
		subagent(pi);
		workflow(pi);
		ultraloopOptIn(pi);
	};
}

export const stepCapabilitiesExtensionInline: InlineExtension = {
	name: "Step capabilities",
	factory: createStepCapabilitiesExtension(),
	hidden: true,
};

/**
 * Build the inline descriptor used by a product entrypoint that owns a
 * telemetry reporter.  The static descriptor above remains useful to Pi
 * embedders that do not have a Step reporter.
 */
export function createStepCapabilitiesExtensionInline(options: StepCapabilitiesExtensionOptions = {}): InlineExtension {
	return {
		name: "Step capabilities",
		factory: createStepCapabilitiesExtension(options),
		hidden: true,
	};
}
