/**
 * session-events.ts — the agent event subscription + the ~24-case handleEvent switch (S4-1 STEP 4).
 *
 * The switch is relocated VERBATIM from InteractiveMode (only `this.` → `ctx.`). Two things
 * are re-routed and nothing else:
 *   - every `this.ui.requestRender()` already became `ctx.redraw.requestRender()` in STEP 1;
 *   - the escape save/restore swaps stay as plain `ctx.defaultEditor.onEscape` assignments
 *     (byte-for-byte, NOT a keyed arbiter) so the nested save-restore semantics survive.
 *
 * Everything else is preserved: direct view construction (`new ToolExecutionComponent`,
 * `ctx.createAssistantMessageComponent`) and mutation (chatContainer.addChild/removeChild,
 * updateContent) — a LEGAL runtime→view edge — and the host-owned continuity invariants
 * (streamingComponent/streamingMessage/pendingTools/workingOutputTracker), which are mutated
 * through the live `ctx` (ctx IS the host instance, so reassigned scalars share by reference).
 *
 * Load-bearing invariants kept exactly: footer.invalidate() as the FIRST action of every
 * event; the intentional double-invalidate in compaction_end; the retry handler restored
 * TWICE (agent_start defensive @ retryEscapeHandler + auto_retry_end); the lazy init guard
 * before the first event; getShowTerminalProgress read LIVE (never snapshotted) at
 * turn_start/compaction_start/compaction_end; per-case requestRender placement 1:1 with no
 * coalescing; message_end updateContent(false) before undefining streamingComponent;
 * agent_end removeChild before undefine. The subscribe/unsubscribe pair is owned by the
 * composition root and moved in lockstep with rebindCurrentSession.
 */

import { type AgentSessionEvent, createCompactionSummaryMessage, theme } from "@earendil-works/pi-coding-agent";
import { Spacer, Text } from "@earendil-works/pi-tui";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	RetryStatusIndicator,
	ToolExecutionComponent,
} from "../view/index.ts";
import type { RuntimeContext } from "./context.ts";

/** Subscribe to the session's agent events. Returns/records the unsubscribe handle (owned by the composition root). */
export function subscribeToAgent(ctx: RuntimeContext): void {
	ctx.unsubscribe = ctx.session.subscribe(async (event) => {
		await handleSessionEvent(ctx, event);
	});
}

export async function handleSessionEvent(ctx: RuntimeContext, event: AgentSessionEvent): Promise<void> {
	if (!ctx.isInitialized) {
		await ctx.init();
	}

	ctx.footer.invalidate();

	switch (event.type) {
		case "agent_start":
			if (ctx.presentation === "step") ctx.workingOutputTracker.reset();
			ctx.pendingTools.clear();
			ctx.stepSpinner?.clear();
			// Restore main escape handler if retry handler is still active
			// (retry success event fires later, but we need main handler now)
			if (ctx.retryEscapeHandler) {
				ctx.defaultEditor.onEscape = ctx.retryEscapeHandler;
				ctx.retryEscapeHandler = undefined;
			}
			break;

		case "turn_start":
			if (ctx.settingsManager.getShowTerminalProgress()) {
				ctx.ui.terminal.setProgress(true);
			}
			if (ctx.workingVisible) {
				if (ctx.activeStatusIndicator?.kind !== "working") {
					ctx.showWorkingStatusIndicator();
				}
			} else {
				ctx.clearStatusIndicator();
			}
			ctx.redraw.requestRender();
			break;

		case "queue_update":
			ctx.updatePendingMessagesDisplay();
			ctx.redraw.requestRender();
			break;

		case "entry_appended":
			if (event.entry.type === "custom") {
				ctx.addCustomEntryToChat(event.entry);
				ctx.redraw.requestRender();
			}
			break;

		case "session_info_changed":
			ctx.updateTerminalTitle();
			ctx.footer.invalidate();
			ctx.redraw.requestRender();
			break;

		case "thinking_level_changed":
			ctx.footer.invalidate();
			ctx.updateEditorBorderColor();
			break;

		case "message_start":
			if (event.message.role === "custom") {
				ctx.addMessageToChat(event.message);
				ctx.redraw.requestRender();
			} else if (event.message.role === "user") {
				ctx.addMessageToChat(event.message);
				ctx.updatePendingMessagesDisplay();
				ctx.redraw.requestRender();
			} else if (event.message.role === "assistant") {
				ctx.streamingComponent = ctx.createAssistantMessageComponent(
					undefined,
					ctx.hideThinkingBlock,
					ctx.getMarkdownThemeWithSettings(),
					ctx.hiddenThinkingLabel,
					ctx.outputPad,
					ctx.getMarkdownTransformers(),
				);
				ctx.streamingMessage = event.message;
				ctx.chatContainer.addChild(ctx.streamingComponent);
				ctx.streamingComponent.updateContent(ctx.streamingMessage, true);
				ctx.redraw.requestRender();
			}
			break;

		case "message_update":
			if (ctx.presentation === "step" && event.message.role === "assistant") {
				ctx.workingOutputTracker.update(event.assistantMessageEvent);
			}
			if (ctx.streamingComponent && event.message.role === "assistant") {
				ctx.streamingMessage = event.message;
				ctx.streamingComponent.updateContent(ctx.streamingMessage, true);

				for (const content of ctx.streamingMessage.content) {
					if (content.type === "toolCall") {
						if (!ctx.pendingTools.has(content.id)) {
							const component = new ToolExecutionComponent(
								content.name,
								content.id,
								content.arguments,
								{
									showImages: ctx.settingsManager.getShowImages(),
									imageWidthCells: ctx.settingsManager.getImageWidthCells(),
									presentation: ctx.options.tuiStyle === "step" ? "step" : "native",
									spinner: ctx.stepSpinner,
								},
								ctx.getRegisteredToolDefinition(content.name),
								ctx.ui,
								ctx.sessionManager.getCwd(),
							);
							component.setExpanded(ctx.toolOutputExpanded);
							ctx.chatContainer.addChild(component);
							ctx.pendingTools.set(content.id, component);
						} else {
							const component = ctx.pendingTools.get(content.id);
							if (component) {
								component.updateArgs(content.arguments);
							}
						}
					}
				}
				ctx.redraw.requestRender();
			}
			break;

		case "message_end":
			if (event.message.role === "user") break;
			if (ctx.presentation === "step" && event.message.role === "assistant") {
				ctx.workingOutputTracker.complete(event.message);
			}
			if (ctx.streamingComponent && event.message.role === "assistant") {
				ctx.streamingMessage = event.message;
				let errorMessage: string | undefined;
				if (ctx.streamingMessage.stopReason === "aborted") {
					const retryAttempt = ctx.session.retryAttempt;
					errorMessage =
						retryAttempt > 0
							? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
							: "Operation aborted";
					ctx.streamingMessage.errorMessage = errorMessage;
				}
				ctx.streamingComponent.updateContent(ctx.streamingMessage, false);

				if (ctx.streamingMessage.stopReason === "aborted" || ctx.streamingMessage.stopReason === "error") {
					if (!errorMessage) {
						errorMessage = ctx.streamingMessage.errorMessage || "Error";
					}
					for (const [, component] of ctx.pendingTools.entries()) {
						component.updateResult({
							content: [{ type: "text", text: errorMessage }],
							isError: true,
						});
					}
					for (const toolCallId of ctx.pendingTools.keys()) {
						ctx.stepSpinner?.stop(toolCallId);
					}
					ctx.pendingTools.clear();
				} else {
					// Args are now complete - trigger diff computation for edit tools
					for (const [, component] of ctx.pendingTools.entries()) {
						component.setArgsComplete();
					}
					ctx.maybeShowCacheMissNotice(ctx.streamingMessage);
				}
				ctx.streamingComponent = undefined;
				ctx.streamingMessage = undefined;
				ctx.footer.invalidate();
			}
			ctx.redraw.requestRender();
			break;

		case "bash_execution_update":
			// The bash execution callback handles TUI output rendering.
			break;

		case "tool_execution_start": {
			let component = ctx.pendingTools.get(event.toolCallId);
			if (!component) {
				component = new ToolExecutionComponent(
					event.toolName,
					event.toolCallId,
					event.args,
					{
						showImages: ctx.settingsManager.getShowImages(),
						imageWidthCells: ctx.settingsManager.getImageWidthCells(),
						presentation: ctx.options.tuiStyle === "step" ? "step" : "native",
						spinner: ctx.stepSpinner,
					},
					ctx.getRegisteredToolDefinition(event.toolName),
					ctx.ui,
					ctx.sessionManager.getCwd(),
				);
				component.setExpanded(ctx.toolOutputExpanded);
				ctx.chatContainer.addChild(component);
				ctx.pendingTools.set(event.toolCallId, component);
			}
			component.markExecutionStarted();
			ctx.stepSpinner?.start(event.toolCallId);
			ctx.redraw.requestRender();
			break;
		}

		case "tool_execution_update": {
			const component = ctx.pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.partialResult, isError: false }, true);
				ctx.redraw.requestRender();
			}
			break;
		}

		case "tool_execution_end": {
			const component = ctx.pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.result, isError: event.isError });
				ctx.pendingTools.delete(event.toolCallId);
				ctx.stepSpinner?.stop(event.toolCallId);
				ctx.redraw.requestRender();
			}
			break;
		}

		case "agent_end":
			if (ctx.settingsManager.getShowTerminalProgress()) {
				ctx.ui.terminal.setProgress(false);
			}
			ctx.clearStatusIndicator("working");
			if (ctx.streamingComponent) {
				ctx.chatContainer.removeChild(ctx.streamingComponent);
				ctx.streamingComponent = undefined;
				ctx.streamingMessage = undefined;
			}
			ctx.pendingTools.clear();
			ctx.stepSpinner?.clear();

			ctx.redraw.requestRender();
			break;

		case "agent_settled":
			await ctx.checkShutdownRequested();
			break;

		case "compaction_start": {
			if (ctx.settingsManager.getShowTerminalProgress()) {
				ctx.ui.terminal.setProgress(true);
			}
			// Keep editor active; submissions are queued during compaction.
			ctx.autoCompactionEscapeHandler = ctx.defaultEditor.onEscape;
			ctx.defaultEditor.onEscape = () => {
				ctx.session.abortCompaction();
			};
			ctx.showStatusIndicator(new CompactionStatusIndicator(ctx.ui, event.reason, ctx.presentation));
			ctx.redraw.requestRender();
			break;
		}

		case "compaction_end": {
			if (ctx.settingsManager.getShowTerminalProgress()) {
				ctx.ui.terminal.setProgress(false);
			}
			if (ctx.autoCompactionEscapeHandler) {
				ctx.defaultEditor.onEscape = ctx.autoCompactionEscapeHandler;
				ctx.autoCompactionEscapeHandler = undefined;
			}
			ctx.clearStatusIndicator("compaction");
			if (event.aborted) {
				if (event.reason === "manual") {
					ctx.showError("Compaction cancelled");
				} else {
					ctx.showStatus("Auto-compaction cancelled");
				}
			} else if (event.result) {
				const entries = ctx.sessionManager.buildContextEntries();
				if (entries[0]?.type !== "compaction") {
					throw new Error("Completed compaction is missing from the session context");
				}
				ctx.chatContainer.clear();
				// The latest compaction is prepended for model context; append it below at its chronological position.
				ctx.renderSessionEntries(entries.slice(1));
				ctx.addMessageToChat(
					createCompactionSummaryMessage(
						event.result.summary,
						event.result.tokensBefore,
						new Date().toISOString(),
					),
				);
				if (event.result.usage) {
					ctx.addCompactionCostNotice({
						type: "compaction_cost",
						kind: "compaction",
						usage: event.result.usage,
					});
				}
				ctx.footer.invalidate();
			} else if (event.errorMessage) {
				if (event.reason === "manual") {
					ctx.showError(event.errorMessage);
				} else {
					ctx.chatContainer.addChild(new Spacer(1));
					ctx.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
				}
			}
			void ctx.flushCompactionQueue({ willRetry: event.willRetry });
			ctx.redraw.requestRender();
			break;
		}

		case "auto_retry_start": {
			// Set up escape to abort retry
			ctx.retryEscapeHandler = ctx.defaultEditor.onEscape;
			ctx.defaultEditor.onEscape = () => {
				ctx.session.abortRetry();
			};
			ctx.showStatusIndicator(
				new RetryStatusIndicator(ctx.ui, event.attempt, event.maxAttempts, event.delayMs, ctx.presentation),
			);
			ctx.redraw.requestRender();
			break;
		}

		case "auto_retry_end": {
			// Restore escape handler
			if (ctx.retryEscapeHandler) {
				ctx.defaultEditor.onEscape = ctx.retryEscapeHandler;
				ctx.retryEscapeHandler = undefined;
			}
			ctx.clearStatusIndicator("retry");
			// Show error only on final failure (success shows normal response)
			if (!event.success) {
				ctx.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
			}
			ctx.redraw.requestRender();
			break;
		}

		case "summarization_retry_scheduled": {
			ctx.showError(event.errorMessage);
			ctx.showStatusIndicator(
				new RetryStatusIndicator(ctx.ui, event.attempt, event.maxAttempts, event.delayMs, ctx.presentation),
			);
			ctx.redraw.requestRender();
			break;
		}

		case "summarization_retry_attempt_start": {
			ctx.clearStatusIndicator("retry");
			if (event.source === "branchSummary") {
				ctx.showStatusIndicator(new BranchSummaryStatusIndicator(ctx.ui, ctx.presentation));
			} else {
				ctx.showStatusIndicator(new CompactionStatusIndicator(ctx.ui, event.reason, ctx.presentation));
			}
			ctx.redraw.requestRender();
			break;
		}

		case "summarization_retry_finished": {
			ctx.clearStatusIndicator("retry");
			ctx.redraw.requestRender();
			break;
		}
	}
}
