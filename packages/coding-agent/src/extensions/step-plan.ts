/**
 * Step's plan-mode extension.
 *
 * The implementation follows Pi's plan-mode example, but uses Step's
 * model-facing tool names. State and interaction still go through Pi's
 * ExtensionAPI; there is no parallel plan state machine in the Step layer.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../core/extensions/types.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "../step/telemetry.ts";

const PLAN_TOOLS = ["read_file", "find_files", "search_files", "list_directory", "run_command", "clarify_user"];
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "write", "edit"]);

interface PlanItem {
	step: number;
	text: string;
	completed: boolean;
}

interface PlanState {
	enabled: boolean;
	executing: boolean;
	todos: PlanItem[];
	toolsBeforePlanMode?: string[];
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function extractPlanItems(text: string): PlanItem[] {
	const header = /(?:^|\n)\s*\*{0,2}Plan:\*{0,2}\s*\n/i.exec(text);
	if (!header) return [];
	const section = text.slice(header.index + header[0].length);
	const items: PlanItem[] = [];
	for (const match of section.matchAll(/^\s*\d+[.)]\s+(.+)$/gmu)) {
		const value = match[1]
			.replace(/\*{1,2}/gu, "")
			.replace(/`/gu, "")
			.trim();
		if (value.length > 2 && items.length < 32) {
			items.push({ step: items.length + 1, text: value, completed: false });
		}
	}
	return items;
}

function isSafeCommand(command: string): boolean {
	if (/(^|\s)(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|sudo|kill|reboot)\b/iu.test(command)) return false;
	if (
		/(^|\s)(git\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert)|npm\s+(install|uninstall|update|publish)|pnpm\s+(add|remove|install|publish)|yarn\s+(add|remove|install|publish))\b/iu.test(
			command,
		)
	) {
		return false;
	}
	if (/[<>]{1,2}/u.test(command)) return false;
	return /^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|type|env|printenv|uname|whoami|id|date|git\s+(status|log|diff|show|branch|remote)|rg|fd|sed|awk|node\s+--version|python\s+--version)\b/iu.test(
		command,
	);
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function updateStatus(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	enabled: boolean,
	executing: boolean,
	todos: PlanItem[],
): void {
	if (executing && todos.length > 0) {
		const completed = todos.filter((item) => item.completed).length;
		ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `plan ${completed}/${todos.length}`));
		ctx.ui.setWidget(
			"plan-todos",
			todos.map((item) =>
				item.completed
					? ctx.ui.theme.fg("muted", `done ${item.step}. ${item.text}`)
					: ctx.ui.theme.fg("text", `todo ${item.step}. ${item.text}`),
			),
		);
	} else if (enabled) {
		ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "plan"));
		ctx.ui.setWidget("plan-todos", undefined);
	} else {
		ctx.ui.setStatus("plan-mode", undefined);
		ctx.ui.setWidget("plan-todos", undefined);
	}
	void pi;
}

function persist(pi: ExtensionAPI, state: PlanState): void {
	pi.appendEntry("step-plan", state);
}

function recordPlanUpdate(
	telemetry: StepTelemetryReporter | undefined,
	previous: readonly PlanItem[],
	items: readonly PlanItem[],
): void {
	if (!telemetry) return;
	trackStepTelemetry(telemetry, "plan_updated", {
		item_count: items.length,
		completed_count: items.filter((item) => item.completed).length,
		// The compact Step plan has no explicit in-progress field. During
		// execution the first unfinished item is the active one.
		in_progress_count: items.some((item) => !item.completed) ? 1 : 0,
		created: previous.length === 0 && items.length > 0,
	});
}

/** Create Step's native plan extension. */
export const createStepPlanExtension =
	(options: { telemetry?: StepTelemetryReporter } = {}): ExtensionFactory =>
	(pi: ExtensionAPI): void => {
		let enabled = false;
		let executing = false;
		let todos: PlanItem[] = [];
		let toolsBeforePlanMode: string[] | undefined;

		const enable = (): void => {
			if (!toolsBeforePlanMode) toolsBeforePlanMode = pi.getActiveTools();
			const active = pi.getActiveTools();
			pi.setActiveTools(unique([...active.filter((name) => !MUTATING_TOOLS.has(name)), ...PLAN_TOOLS]));
		};
		const restore = (): void => {
			if (toolsBeforePlanMode) {
				pi.setActiveTools(toolsBeforePlanMode);
			} else {
				pi.setActiveTools(
					unique([
						"read_file",
						"find_files",
						"search_files",
						"list_directory",
						"run_command",
						"write_file",
						"edit_file",
						...pi.getActiveTools(),
					]),
				);
			}
			toolsBeforePlanMode = undefined;
		};
		const toggle = (ctx: ExtensionContext): void => {
			enabled = !enabled;
			executing = false;
			todos = [];
			if (enabled) {
				enable();
				ctx.ui.notify("Plan mode enabled. File mutation and command execution are disabled.", "info");
			} else {
				restore();
				ctx.ui.notify("Plan mode disabled.", "info");
			}
			updateStatus(pi, ctx, enabled, executing, todos);
			persist(pi, { enabled, executing, todos, toolsBeforePlanMode });
		};

		pi.registerFlag("plan", {
			description: "Start in plan mode (read-only exploration)",
			type: "boolean",
			default: false,
		});
		pi.registerCommand("plan", {
			description: "Toggle plan mode (read-only exploration)",
			handler: async (_args, ctx) => toggle(ctx),
		});
		pi.registerCommand("todos", {
			description: "Show the current plan",
			handler: async (_args, ctx) => {
				if (todos.length === 0) {
					ctx.ui.notify("No plan is currently tracked.", "info");
					return;
				}
				ctx.ui.notify(
					todos.map((item) => `${item.completed ? "done" : "todo"} ${item.step}. ${item.text}`).join("\n"),
					"info",
				);
			},
		});
		pi.on("tool_call", async (event) => {
			if (!enabled || event.toolName !== "run_command") return;
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode blocked this command. Disable plan mode first.\nCommand: ${command}`,
				};
			}
		});

		pi.on("context", async (event) => {
			if (enabled) return;
			return {
				messages: event.messages.filter((message) => {
					const candidate = message as AgentMessage & { customType?: string };
					if (candidate.customType === "step-plan-context") return false;
					return !assistantTextIfPresent(message).includes("[STEP PLAN MODE ACTIVE]");
				}),
			};
		});

		pi.on("before_agent_start", async () => {
			if (enabled) {
				return {
					message: {
						customType: "step-plan-context",
						content:
							"[STEP PLAN MODE ACTIVE]\nYou are in read-only planning mode. Inspect the repository, ask focused questions with clarify_user, and return a numbered Plan:. Do not mutate files; run_command is limited to read-only commands.",
						display: false,
					},
				};
			}
			if (executing && todos.length > 0) {
				return {
					message: {
						customType: "step-plan-execution-context",
						content: `[STEP PLAN EXECUTION]\nRemaining steps:\n${todos
							.filter((item) => !item.completed)
							.map((item) => `${item.step}. ${item.text}`)
							.join("\n")}\nMark completed work with [DONE:n].`,
						display: false,
					},
				};
			}
		});

		pi.on("turn_end", async (event) => {
			if (!executing || !isAssistantMessage(event.message)) return;
			const previous = todos.map((item) => ({ ...item }));
			for (const match of assistantText(event.message).matchAll(/\[DONE:(\d+)\]/giu)) {
				const item = todos.find((candidate) => candidate.step === Number(match[1]));
				if (item && !item.completed) item.completed = true;
			}
			if (previous.some((item, index) => item.completed !== todos[index]?.completed)) {
				recordPlanUpdate(options.telemetry, previous, todos);
			}
			persist(pi, { enabled, executing, todos, toolsBeforePlanMode });
		});

		pi.on("agent_end", async (event, ctx) => {
			if (executing) {
				if (todos.length > 0 && todos.every((item) => item.completed)) {
					const previous = todos.map((item) => ({ ...item }));
					executing = false;
					todos = [];
					recordPlanUpdate(options.telemetry, previous, todos);
					updateStatus(pi, ctx, enabled, executing, todos);
					persist(pi, { enabled, executing, todos, toolsBeforePlanMode });
				}
				return;
			}
			if (!enabled || !ctx.hasUI) return;
			const last = [...event.messages].reverse().find(isAssistantMessage);
			const previous = todos.map((item) => ({ ...item }));
			if (last) todos = extractPlanItems(assistantText(last));
			if (todos.length === 0) return;
			recordPlanUpdate(options.telemetry, previous, todos);
			persist(pi, { enabled, executing, todos, toolsBeforePlanMode });
			const choice = await ctx.ui.select("Plan ready", ["Execute the plan", "Stay in plan mode", "Refine the plan"]);
			if (choice === "Execute the plan") {
				enabled = false;
				executing = true;
				restore();
				updateStatus(pi, ctx, enabled, executing, todos);
				persist(pi, { enabled, executing, todos, toolsBeforePlanMode });
				pi.sendUserMessage(
					`Execute the plan.\n\n${todos.map((item) => `${item.step}. ${item.text}`).join("\n")}\n\nStart with step 1 and include [DONE:n] after each completed step.`,
					{ deliverAs: "followUp" },
				);
			} else if (choice === "Refine the plan") {
				const refinement = await ctx.ui.editor("Refine the plan:", "");
				if (refinement?.trim()) pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		});

		pi.on("session_start", async (_event, ctx) => {
			if (pi.getFlag("plan") === true) enabled = true;
			const entry = [...ctx.sessionManager.getEntries()]
				.reverse()
				.find((candidate) => candidate.type === "custom" && candidate.customType === "step-plan") as
				| { data?: PlanState }
				| undefined;
			if (entry?.data) {
				enabled = entry.data.enabled;
				executing = entry.data.executing;
				todos = entry.data.todos ?? [];
				toolsBeforePlanMode = entry.data.toolsBeforePlanMode;
			}
			if (enabled) enable();
			updateStatus(pi, ctx, enabled, executing, todos);
		});
	};

export const stepPlanExtension = createStepPlanExtension();

function assistantTextIfPresent(message: AgentMessage): string {
	if (isAssistantMessage(message)) return assistantText(message);
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: unknown }).content;
	return typeof content === "string" ? content : "";
}
