import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { type Component, Loader, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import { keyText } from "../../../render/keybinding-hints.ts";
import { theme } from "../../../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { formatTokens } from "./footer.ts";

/** Refresh cadence for the compact Step working indicator. */
export const STEP_WORKING_INDICATOR_INTERVAL_MS = 200;

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

export interface WorkingOutputSnapshot {
	elapsedSeconds: number;
	outputTokens: number;
	phase: "thinking" | undefined;
}

export class WorkingOutputTracker {
	private startedAt = Date.now();
	private completedOutputTokens = 0;
	private currentOutputChars = 0;
	private phase: "thinking" | undefined;

	reset(startedAt = Date.now()): void {
		this.startedAt = startedAt;
		this.completedOutputTokens = 0;
		this.currentOutputChars = 0;
		this.phase = undefined;
	}

	update(event: AssistantMessageEvent): void {
		switch (event.type) {
			case "thinking_delta":
				this.currentOutputChars += event.delta.length;
				this.phase = "thinking";
				break;
			case "thinking_start":
			case "thinking_end":
				this.phase = "thinking";
				break;
			case "text_delta":
			case "toolcall_delta":
				this.currentOutputChars += event.delta.length;
				this.phase = undefined;
				break;
			case "toolcall_start": {
				const block = event.partial.content[event.contentIndex];
				if (block?.type === "toolCall") this.currentOutputChars += block.name.length;
				this.phase = undefined;
				break;
			}
			case "text_start":
			case "text_end":
			case "toolcall_end":
				this.phase = undefined;
				break;
		}
	}

	complete(message: AssistantMessage): void {
		const estimatedTokens = Math.round(this.currentOutputChars / 4);
		this.completedOutputTokens += message.usage.output > 0 ? message.usage.output : estimatedTokens;
		this.currentOutputChars = 0;
		this.phase = undefined;
	}

	snapshot(now = Date.now()): WorkingOutputSnapshot {
		return {
			elapsedSeconds: Math.max(0, Math.floor((now - this.startedAt) / 1000)),
			outputTokens: this.completedOutputTokens + Math.round(this.currentOutputChars / 4),
			phase: this.phase,
		};
	}
}

function formatElapsedTime(totalSeconds: number): string {
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;
	protected readonly presentation: "native" | "step";

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
		presentation: "native" | "step" = "native",
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
		this.presentation = presentation;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.presentation !== "step") return lines;
		// Pi's Loader deliberately reserves a leading blank row for its native
		// status block. Step keeps the same Loader animation but presents it as a
		// compact single row below the transcript.
		const first = lines.find((line) => line.trim().length > 0) ?? "";
		return [visibleWidth(first) > width ? truncateToWidth(first, width, "", false) : first];
	}

	dispose(): void {
		this.stop();
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	private readonly outputTracker: WorkingOutputTracker | undefined;

	constructor(
		ui: TUI,
		message: string,
		indicator?: WorkingIndicatorOptions,
		presentation: "native" | "step" = "native",
		outputTracker?: WorkingOutputTracker,
	) {
		super(
			"working",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			message,
			indicator,
			presentation,
		);
		this.outputTracker = outputTracker;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.presentation !== "step" || !this.outputTracker) return lines;

		const snapshot = this.outputTracker.snapshot();
		const phase = snapshot.phase ? ` · ${snapshot.phase}` : "";
		const suffix = theme.fg(
			"muted",
			` (${formatElapsedTime(snapshot.elapsedSeconds)} · ↓ ${formatTokens(snapshot.outputTokens)} tokens${phase})`,
		);
		const line = `${(lines[0] ?? "").trimEnd()}${suffix}`;
		return [visibleWidth(line) > width ? truncateToWidth(line, width, "", false) : line];
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(
		ui: TUI,
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		presentation: "native" | "step" = "native",
	) {
		const retryMessage = (seconds: number) =>
			`Retrying (${attempt}/${maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(delayMs / 1000)),
			undefined,
			presentation,
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

export type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class CompactionStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, reason: CompactionStatusReason, presentation: "native" | "step" = "native") {
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		const label =
			reason === "manual"
				? `Compacting context... ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
			undefined,
			presentation,
		);
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, presentation: "native" | "step" = "native") {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
			undefined,
			presentation,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
