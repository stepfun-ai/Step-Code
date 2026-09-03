/** Step's built-in clarification, plan, task-tracking, and delegated-agent extensions. */

import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "../core/extensions/types.ts";
import type { StepTelemetryReporter } from "../step/telemetry.ts";
import { createStepPlanExtension } from "./step-plan.ts";
import { registerStepClarifyUserExtension } from "./step-questionnaire.ts";
import { createStepSubagentExtension, type StepSubagentExtensionOptions } from "./step-subagent.ts";
import { createStepTasksExtension } from "./step-tasks.ts";

export interface StepCapabilitiesExtensionOptions {
	subagent?: StepSubagentExtensionOptions;
	/** Optional process reporter; capability adapters never own delivery. */
	telemetry?: StepTelemetryReporter;
}

/** Compose Pi's native UI examples behind one Step-owned inline extension. */
export function createStepCapabilitiesExtension(options: StepCapabilitiesExtensionOptions = {}): ExtensionFactory {
	const plan = createStepPlanExtension({ telemetry: options.telemetry });
	const tasks = createStepTasksExtension();
	const subagent = createStepSubagentExtension({
		...options.subagent,
		telemetry: options.telemetry,
	});
	return (pi: ExtensionAPI): void => {
		registerStepClarifyUserExtension(pi, options.telemetry);
		plan(pi);
		tasks(pi);
		subagent(pi);
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
