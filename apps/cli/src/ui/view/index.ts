// Sole view-layer barrel.
// Exposes the region-assembly entry points the runtime layer consumes today.
// runtime -> view is the only legal cross-layer edge into view; nothing else
// should import through here.

export { FooterComponent } from "./chrome/footer.ts";
export {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	RetryStatusIndicator,
	StatusIndicator,
	TurnDoneIndicator,
	WorkingOutputTracker,
	WorkingStatusIndicator,
} from "./chrome/status-indicator.ts";
export { buildStatusTips, StatusTipRotator } from "./chrome/status-tips.ts";
export { StepWelcomeComponent } from "./chrome/step-welcome.ts";
export { AssistantMessageComponent } from "./transcript/assistant-message.ts";
export { StepToolSpinnerClock } from "./transcript/step-spinner.ts";
export { ToolExecutionComponent } from "./transcript/tool-execution.ts";
