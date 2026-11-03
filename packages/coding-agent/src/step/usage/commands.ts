import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { collectSessionUsage } from "../../core/usage-totals.ts";
import { getStepPlanMode } from "../../features/step-plan.ts";
import { STEPCODE_VERSION } from "../version.ts";
import { type PlanUsageController, usageText } from "./account.ts";
import { overviewDates } from "./activity.ts";
import { registerUsageRecording } from "./recording.ts";
import type { UsageOverview, UsagePresentation, UsageResources, UsageStatus, UsageView } from "./types.ts";

export const USAGE_COMMAND_HELP = "Usage: /usage [overview|account] | /usage --refresh | /usage account --refresh";
export function parseUsageCommand(args: string): { view: UsageView; refresh: boolean } | undefined {
	const text = args.trim().replace(/\s+/gu, " ");
	if (text === "" || text === "overview") return { view: "overview", refresh: false };
	if (text === "account") return { view: "account", refresh: false };
	if (["--refresh", "account --refresh"].includes(text)) return { view: "account", refresh: true };
	return undefined;
}
export interface StepUsageHost {
	account: PlanUsageController;
	resources(): UsageResources;
	scan(cwd: string, scope: "all" | "project", signal: AbortSignal): Promise<UsageOverview>;
	present(ctx: ExtensionCommandContext, presentation: UsagePresentation): Promise<void>;
	output?(ctx: ExtensionCommandContext, presentation: UsagePresentation): void;
}

export function registerStepUsageCommands(
	pi: ExtensionAPI,
	host: StepUsageHost | undefined,
	permissions: () => string,
): {
	usage(args: string, ctx: ExtensionCommandContext): Promise<void>;
	status(args: string, ctx: ExtensionCommandContext): Promise<void>;
} {
	let generation = 0,
		closeView: (() => void) | undefined;
	let updateSession: ((ctx: ExtensionContext) => void) | undefined;
	pi.on("agent_end", (_event, ctx) => updateSession?.(ctx));
	const close = (): void => {
		generation++;
		closeView?.();
		host?.account.cancel();
	};
	pi.on("session_start", close);
	pi.on("session_shutdown", close);
	registerUsageRecording(pi, host ? () => host.resources() : undefined);

	const capture = (ctx: ExtensionCommandContext): UsageStatus => {
		const model = ctx.model,
			context = ctx.getContextUsage(),
			cached = host?.account.readCached() ?? {
				status: "unsupported" as const,
				account: { presence: "missing" as const, eligible: false, source: "none" },
				message: "Account service is not configured by this host.",
			};
		let endpoint: string | undefined;
		try {
			const url = new URL(model?.baseUrl ?? "");
			endpoint = `${url.origin}${url.pathname}`;
		} catch {
			/* no endpoint */
		}
		return {
			model: usageText(model?.id ?? "Not configured"),
			provider: usageText(model?.provider ?? "Not configured"),
			reasoning: ctx.thinkingLevel ?? "Unknown",
			directory: usageText(ctx.cwd),
			permissions: usageText(permissions()),
			trusted: ctx.isProjectTrusted(),
			agents: (host?.resources().agents ?? ctx.getSystemPromptOptions().contextFiles?.map((f) => f.path) ?? []).map(
				usageText,
			),
			collaboration: getStepPlanMode(ctx.sessionManager),
			session: ctx.sessionManager.getSessionId(),
			state: `${ctx.isIdle() ? "idle" : "busy"}${ctx.hasPendingMessages() ? " · queued messages" : ""}`,
			context:
				context?.tokens === null || !context
					? "Unknown"
					: `${context.tokens ?? "?"} / ${context.contextWindow ?? "?"} tokens`,
			account: cached.account,
			cached,
			version: STEPCODE_VERSION.value,
			endpoint,
		};
	};
	const show = async (ctx: ExtensionCommandContext, view: UsageView | "status", force = false): Promise<void> => {
		closeView?.();
		const token = ++generation,
			status = capture(ctx),
			session = collectSessionUsage(ctx.sessionManager.getEntries()),
			cwd = ctx.cwd;
		let scan: AbortController | undefined,
			closed = false;
		const valid = (): boolean => !closed && generation === token;
		const model: UsagePresentation = {
			view,
			session,
			status,
			account: status.cached,
			scope: "all",
			selectedDate: overviewDates().at(-1)!,
			select: () => {},
			refresh: () => {},
			selectScope: () => {},
		};
		const changed = (): void => {
			if (valid()) model.onChange?.();
		};
		updateSession = (current) => {
			if (valid() && current.sessionManager.getSessionId() === status.session && model.view === "account") {
				model.session = collectSessionUsage(current.sessionManager.getEntries());
				changed();
			}
		};
		const query = (refresh: boolean): void => {
			if (!host || !valid() || model.view !== "account") return;
			const promise = host.account.query(refresh);
			model.account = host.account.readCached();
			changed();
			void promise.then((state) => {
				if (valid() && model.view === "account") {
					model.account = state;
					changed();
				}
			});
		};
		const overview = (): void => {
			if (!host || !valid()) return;
			scan?.abort();
			const task = new AbortController();
			scan = task;
			model.overview = undefined;
			model.overviewError = undefined;
			changed();
			void host
				.scan(cwd, model.scope, task.signal)
				.then((result) => {
					if (valid() && scan === task && model.view === "overview") {
						model.overview = result;
						model.overviewError = undefined;
						changed();
					}
				})
				.catch((error: unknown) => {
					if (valid() && scan === task && !task.signal.aborted) {
						model.overviewError = error instanceof Error ? error.message : "Activity unavailable";
						changed();
					}
				});
		};
		model.select = (next) => {
			if (!valid() || model.view === "status") return;
			scan?.abort();
			host?.account.cancel();
			model.view = next;
			if (next === "account") query(false);
			else overview();
			changed();
		};
		model.refresh = () => query(true);
		model.selectScope = (scope) => {
			if (!valid() || model.view !== "overview") return;
			model.scope = scope;
			overview();
		};
		const close = (): void => {
			if (closed) return;
			closed = true;
			updateSession = undefined;
			scan?.abort();
			host?.account.cancel();
			model.onClose?.();
			if (closeView === close) closeView = undefined;
		};
		closeView = close;
		if (ctx.mode !== "tui") {
			try {
				if (view === "account" && host) model.account = await host.account.query(force);
				if (view === "overview" && host) {
					scan = new AbortController();
					model.overview = await host.scan(cwd, "all", scan.signal);
				}
				if (valid()) {
					if (host?.output) host.output(ctx, model);
					else ctx.ui.notify("Usage output is unavailable in this host; use the exported data APIs.", "warning");
				}
			} finally {
				close();
			}
			return;
		}
		if (!host) {
			ctx.ui.notify("Usage UI is not configured by this host.", "warning");
			close();
			return;
		}
		if (view === "account") query(force);
		else if (view === "overview") overview();
		try {
			await host.present(ctx, model);
		} finally {
			close();
		}
	};
	return {
		usage: async (args, ctx) => {
			const command = parseUsageCommand(args);
			if (!command) {
				ctx.ui.notify(USAGE_COMMAND_HELP, "warning");
				return;
			}
			await show(ctx, command.view, command.refresh);
		},
		status: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /status", "warning");
				return;
			}
			await show(ctx, "status");
		},
	};
}
