import { randomUUID } from "node:crypto";

export interface ApprovalRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly toolName: string;
	readonly message: string;
	readonly input?: Record<string, unknown>;
	readonly reason?: string;
	readonly createdAt: number;
	readonly preview?: {
		readonly path?: string;
		readonly before?: string;
		readonly after?: string;
	};
}

export type ApprovalEvent =
	| { type: "approval_required"; approval: ApprovalRequest }
	| { type: "error"; message: string };

interface PendingApproval {
	readonly request: ApprovalRequest;
	readonly resolve: (approved: boolean) => void;
}

export class ApprovalBroker {
	private readonly pending = new Map<string, PendingApproval>();
	private readonly alwaysAllow = new Set<string>();
	private readonly toolCalls = new Map<string, { toolName: string; input: Record<string, unknown> }>();
	private readonly sessionId: string;
	private readonly emit: (event: ApprovalEvent) => void;

	constructor(sessionId: string, emit: (event: ApprovalEvent) => void) {
		this.sessionId = sessionId;
		this.emit = emit;
	}

	captureToolCall(toolCallId: string, toolName: string, input: Record<string, unknown>): void {
		this.toolCalls.set(toolCallId.slice(-8), { toolName, input });
		if (this.toolCalls.size > 256) {
			const oldest = this.toolCalls.keys().next().value;
			if (oldest) this.toolCalls.delete(oldest);
		}
	}

	/**
	 * Ask for a verdict on one confirmation.
	 *
	 * `toolName` is the kernel dialog's title, `Approve <tool> [<call id>]` (or
	 * `Dangerous …`). The tool it names is the identity the card and the session
	 * grant use, so the hazard word and the call id are stripped here: callers
	 * pass the title through unchanged, including a subagent's forwarded prompt.
	 */
	confirm(toolName: string, message: string, signal?: AbortSignal): Promise<boolean> {
		const callId = /\[([^\]]+)\]$/u.exec(toolName)?.[1];
		const captured = callId ? this.toolCalls.get(callId.slice(-8)) : undefined;
		if (callId) this.toolCalls.delete(callId.slice(-8));
		const name =
			captured?.toolName ?? toolName.replace(/\s+\[[^\]]+\]$/u, "").replace(/^(?:Approve|Dangerous) /u, "");
		const reason = message
			.split("\n\n", 1)[0]
			.replace(/^Call: [^\n]*\n/u, "")
			.trim();
		// Reuse only ordinary mutation confirmations from the kernel. Danger and
		// incomplete-analysis prompts still require a verdict for each call.
		const reusable = !callId || reason === `${name} can modify the workspace or execute a command`;
		if (reusable && this.alwaysAllow.has(name)) return Promise.resolve(true);
		const id = randomUUID();
		const request = {
			id,
			sessionId: this.sessionId,
			toolName: name,
			message,
			reason,
			createdAt: Date.now(),
			...(captured ? { input: captured.input, preview: previewForTool(captured.input) } : {}),
		};
		return new Promise<boolean>((resolve) => {
			const pending: PendingApproval = { request, resolve };
			this.pending.set(id, pending);
			this.emit({ type: "approval_required", approval: request });
			const onAbort = () => {
				this.pending.delete(id);
				resolve(false);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** Requests still waiting for a verdict, oldest first, so a reloaded page can show them again. */
	pendingRequests(): ApprovalRequest[] {
		return [...this.pending.values()].map((pending) => pending.request);
	}

	decide(id: string, verdict: "approve" | "approve_for_session" | "deny"): boolean {
		const pending = this.pending.get(id);
		if (!pending) return false;
		this.pending.delete(id);
		if (verdict === "approve_for_session") this.alwaysAllow.add(pending.request.toolName);
		pending.resolve(verdict !== "deny");
		return true;
	}

	clear(): void {
		for (const pending of this.pending.values()) pending.resolve(false);
		this.pending.clear();
		this.toolCalls.clear();
	}
}

function previewForTool(input: Record<string, unknown>): ApprovalRequest["preview"] {
	const path = typeof input.path === "string" ? input.path : undefined;
	if (Array.isArray(input.edits)) {
		const edits = input.edits.filter(
			(edit): edit is { oldText: string; newText: string } =>
				typeof edit === "object" &&
				edit !== null &&
				typeof (edit as { oldText?: unknown }).oldText === "string" &&
				typeof (edit as { newText?: unknown }).newText === "string",
		);
		if (edits.length > 0) {
			return {
				path,
				before: edits.map((edit) => edit.oldText).join("\n\n"),
				after: edits.map((edit) => edit.newText).join("\n\n"),
			};
		}
	}
	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		return { path, before: input.oldText, after: input.newText };
	}
	if (typeof input.content === "string") return { path, after: input.content };
	return path ? { path } : undefined;
}
