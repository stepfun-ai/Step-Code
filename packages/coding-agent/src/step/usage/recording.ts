import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { getStepMcpToolOwner } from "../mcp.ts";
import { getStepPluginSkillOwner } from "../plugins.ts";
import type { UsageResources } from "./types.ts";

/** Record through existing extension hooks; never send activity metadata to the model. */
export function registerUsageRecording(pi: ExtensionAPI, resources: (() => UsageResources) | undefined): void {
	if (!resources) return;
	const discovered = new Set<string>();
	const append = (type: string, data: unknown): void => {
		try {
			pi.appendEntry(type, data);
		} catch {
			/* Local recording never changes the task result. */
		}
	};
	const collectResources = (ctx: ExtensionContext): void => {
		const id = ctx.sessionManager.getSessionId();
		for (const skill of resources().skills) {
			const resourceId = resolve(skill.filePath);
			if (discovered.has(resourceId)) continue;
			discovered.add(resourceId);
			append("step.activity", {
				version: 1,
				sessionId: id,
				kind: "skill",
				stage: "discovered",
				resourceId,
				name: `$${skill.name}`,
				runId: `discovery:${resourceId}`,
				startedAt: Date.now(),
			});
		}
	};
	pi.on("session_start", (_event, ctx) => {
		discovered.clear();
		append("step.activity_capabilities", {
			version: 1,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionRole:
				process.env.STEPCODE_SUBAGENT_CHILD === "1" ||
				ctx.sessionManager.getSessionId().startsWith("subagent-") ||
				ctx.sessionManager.getSessionId().startsWith("workflow-")
					? "subagent"
					: "user",
			parentCwd: process.env.STEPCODE_USAGE_PARENT_CWD,
			parentSessionId: process.env.STEPCODE_USAGE_PARENT_SESSION_ID,
			skillDiscovery: true,
			skillActivation: true,
			pluginInvocation: true,
		});
		collectResources(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		collectResources(ctx);
	});
	pi.on("usage_recorded", (event, ctx) => {
		if (event.provenance.sessionId === ctx.sessionManager.getSessionId())
			append("step.usage_provenance", {
				version: 1,
				...event.provenance,
				originSessionId: event.provenance.sessionId,
				usageEntryId: event.entryId,
			});
	});
	pi.on("tool_execution_start", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId(),
			startedAt = Date.now(),
			owner = getStepMcpToolOwner(event.toolName, ctx.sessionManager);
		if (owner)
			append("step.activity", {
				version: 1,
				sessionId,
				runId: event.toolCallId,
				startedAt,
				kind: "plugin",
				resourceId: owner,
				name: `@${owner}`,
			});
		if (event.toolName !== "read" || typeof event.args?.path !== "string") return;
		let path = resolve(ctx.cwd, event.args.path);
		try {
			path = realpathSync(path);
		} catch {
			/* An attempted invocation still counts as a run. */
		}
		const skill = resources().skills.find((s) => {
			try {
				return realpathSync(s.filePath) === path;
			} catch {
				return resolve(s.filePath) === path;
			}
		});
		if (skill)
			append("step.activity", {
				version: 1,
				sessionId,
				runId: event.toolCallId,
				startedAt,
				kind: "skill",
				resourceId: resolve(skill.filePath),
				name: `$${skill.name}`,
				pluginId: getStepPluginSkillOwner(path, ctx.sessionManager),
			});
	});
}
