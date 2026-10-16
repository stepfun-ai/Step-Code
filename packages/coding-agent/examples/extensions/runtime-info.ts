/**
 * Opt-in, local runtime diagnostics. Load with:
 *   step -e ./packages/coding-agent/examples/extensions/runtime-info.ts
 * Then use /runtime-info, or add --runtime-info for automatic reports.
 * See docs/runtime-info.md for the observation limits and output schema.
 */
import type { ExtensionAPI, ExtensionContext } from "@step-harness/coding-agent";

type ResetEvent = "context" | "model_select" | "thinking_level_select" | "session_compact" | "session_tree";
type ReportEvent = ResetEvent | "command" | "session_start" | "before_provider_request";
type RequestLimits = {
	max_output_tokens: number | null;
	max_tokens: number | null;
	max_completion_tokens: number | null;
};

// Read only named, own data properties. Never enumerate, stringify, or invoke
// accessors on provider payloads (including an arbitrary toJSON implementation).
function ownValue(object: unknown, key: string): unknown {
	try {
		if (typeof object !== "object" || object === null || Array.isArray(object)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function identifier(value: unknown): string | null {
	return typeof value === "string" &&
		value.length <= 128 &&
		/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) &&
		!value.includes("://")
		? value
		: null;
}

function tokenCount(value: unknown, minimum = 1): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : null;
}

function thinkingLevel(value: unknown): string | null {
	switch (value) {
		case "off":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return value;
		default:
			return null;
	}
}

function requestLimits(payload: unknown, api: string | null): RequestLimits {
	return {
		max_output_tokens: api === "openai-responses" ? tokenCount(ownValue(payload, "max_output_tokens")) : null,
		max_tokens:
			api === "anthropic-messages" || api === "openai-completions"
				? tokenCount(ownValue(payload, "max_tokens"))
				: null,
		max_completion_tokens:
			api === "openai-completions" ? tokenCount(ownValue(payload, "max_completion_tokens")) : null,
	};
}

export default function runtimeInfo(pi: ExtensionAPI) {
	let enabled = false;
	let lastRequest: RequestLimits | null = null;
	let lastIdentity: string | undefined;
	// undefined: no pending context; null: the pending context was invalidated.
	let pendingIdentity: string | null | undefined;

	pi.registerFlag("runtime-info", {
		description: "Report local runtime metadata and observed request token ceilings",
		type: "boolean",
		default: false,
	});

	function report(event: ReportEvent, ctx: ExtensionContext, payload?: unknown): void {
		const currentModel = ctx.model;
		const model = {
			id: identifier(ownValue(currentModel, "id")),
			provider: identifier(ownValue(currentModel, "provider")),
			api: identifier(ownValue(currentModel, "api")),
			contextWindow: tokenCount(ownValue(currentModel, "contextWindow")),
			configuredMaxTokens: tokenCount(ownValue(currentModel, "maxTokens")),
		};
		const level = thinkingLevel(ctx.thinkingLevel);
		// Session identity is used only to invalidate the in-memory observation;
		// neither session IDs nor paths are included in diagnostics.
		const sessionId = identifier(ctx.sessionManager.getSessionId());
		const identity = JSON.stringify([sessionId, model, level]);
		if (!sessionId || !model.id || !model.provider || !model.api || identity !== lastIdentity) lastRequest = null;
		lastIdentity = identity;
		if (event === "context") pendingIdentity = sessionId && model.id && model.provider && model.api ? identity : null;
		if (event === "before_provider_request") {
			// The hook has no request model or session ID. If the runtime changed
			// since context preparation, do not attribute that payload to it.
			lastRequest =
				pendingIdentity === undefined || pendingIdentity === identity ? requestLimits(payload, model.api) : null;
			pendingIdentity = undefined;
		}

		const usage = ctx.getContextUsage();
		const percent = ownValue(usage, "percent");
		const diagnostic = {
			type: "runtime-info",
			event,
			model,
			thinkingLevel: level,
			contextUsage: {
				tokens: tokenCount(ownValue(usage, "tokens"), 0),
				contextWindow: tokenCount(ownValue(usage, "contextWindow")),
				percent: typeof percent === "number" && Number.isFinite(percent) && percent >= 0 ? percent : null,
			},
			lastRequest,
		};
		// All strings above are fixed labels or bounded ASCII identifiers. Keep
		// each line under 2 KiB, including its newline, even if fields are added.
		const line = JSON.stringify(diagnostic);
		if (line.length + 1 > 2048) return;
		if (ctx.hasUI) ctx.ui.notify(line, "info");
		else process.stderr.write(`${line}\n`);
	}

	pi.registerCommand("runtime-info", {
		description: "Inspect runtime metadata and enable reports for this session; use off to stop",
		handler: async (args, ctx) => {
			if (args.trim() === "off") {
				enabled = false;
				lastRequest = null;
				lastIdentity = undefined;
				pendingIdentity = undefined;
				return;
			}
			enabled = true;
			report("command", ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		lastRequest = null;
		lastIdentity = undefined;
		pendingIdentity = undefined;
		// CLI values are available only after the extension factory has run.
		enabled = pi.getFlag("runtime-info") === true;
		if (enabled) report("session_start", ctx);
	});
	pi.on("session_shutdown", () => {
		enabled = false;
		lastRequest = null;
		lastIdentity = undefined;
		pendingIdentity = undefined;
	});

	const resetAndReport = (event: { type: ResetEvent }, ctx: ExtensionContext): void => {
		lastRequest = null;
		if (event.type !== "context" && pendingIdentity !== undefined) pendingIdentity = null;
		if (enabled) report(event.type, ctx);
	};
	pi.on("context", resetAndReport);
	pi.on("model_select", resetAndReport);
	pi.on("thinking_level_select", resetAndReport);
	pi.on("session_compact", resetAndReport);
	pi.on("session_tree", resetAndReport);
	pi.on("before_provider_request", (event, ctx) => {
		if (enabled) report("before_provider_request", ctx, event.payload);
		// Returning anything other than undefined would replace the request.
	});
}
