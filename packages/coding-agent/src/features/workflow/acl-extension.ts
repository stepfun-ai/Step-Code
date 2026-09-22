import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "../../step/telemetry.ts";
import { checkWorkflowToolCall } from "./tool-profile.ts";

export const WORKFLOW_ACL_ENV = "STEP_WORKFLOW_ACL";

interface ChildAclPayload {
	baseCwd?: string;
	readOnly?: string[];
	writable?: string[];
}

/** Install the child-side choke point used by workflow-launched subagents. */
export function registerWorkflowChildAcl(pi: ExtensionAPI, telemetry?: StepTelemetryReporter): boolean {
	const encoded = process.env[WORKFLOW_ACL_ENV]?.trim();
	if (!encoded) return false;
	let payload: ChildAclPayload;
	try {
		const parsed: unknown = JSON.parse(encoded);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		const value = parsed as Record<string, unknown>;
		payload = {
			baseCwd: typeof value.baseCwd === "string" ? value.baseCwd : undefined,
			readOnly: stringArray(value.readOnly),
			writable: stringArray(value.writable),
		};
	} catch {
		return false;
	}
	const baseCwd = payload.baseCwd?.trim() || process.cwd();
	pi.on("tool_call", async (event) => {
		const decision = checkWorkflowToolCall(baseCwd, event.toolName, event.input, payload);
		if (decision.allowed) return;
		if (telemetry) {
			trackStepTelemetry(telemetry, "workflow_acl_blocked", {
				operation: decision.operation,
				reason_code: "tool_call",
			});
		}
		return { block: true, reason: decision.reason ?? "Workflow ACL blocked this tool call" };
	});
	return true;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
	return result.length > 0 ? result : undefined;
}
