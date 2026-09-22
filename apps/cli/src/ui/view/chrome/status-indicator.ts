import type { WorkingIndicatorOptions } from "@step-harness/coding-agent";
import { keyText, theme } from "@step-harness/coding-agent";
import { type Component, Loader, type TUI, truncateToWidth, visibleWidth } from "@step-harness/pi-tui";
import type { AssistantMessage, AssistantMessageEvent } from "@step-harness/providers";
import { CountdownTimer } from "../dialogs/countdown-timer.ts";
import { estimateTokens, formatElapsedTime, formatTokens } from "./footer.ts";

/** Refresh cadence for the compact Step working indicator. */
export const STEP_WORKING_INDICATOR_INTERVAL_MS = 200;

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

export interface WorkingOutputSnapshot {
	elapsedSeconds: number;
	outputTokens: number;
	phase: "thinking" | undefined;
	/**
	 * False from the moment a tool starts until the model emits new prose
	 * (text delta) or thinking. While false the rotation must NOT demote the
	 * verb to "Working..." — a short tool's verb would otherwise be visible
	 * for a random 0-4s slice of the tick phase, i.e. not at all.
	 */
	idleVerbAllowed: boolean;
}

export class WorkingOutputTracker {
	private startedAt = Date.now();
	private completedOutputTokens = 0;
	private currentOutputChars = 0;
	private phase: "thinking" | undefined;
	private idleVerbAllowed = true;

	reset(startedAt = Date.now()): void {
		this.startedAt = startedAt;
		this.completedOutputTokens = 0;
		this.currentOutputChars = 0;
		this.phase = undefined;
		this.idleVerbAllowed = true;
	}

	/** A tool started: hold its verb until the model produces new output. */
	notifyToolStarted(): void {
		this.idleVerbAllowed = false;
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
				this.idleVerbAllowed = true;
				break;
			case "text_delta":
			case "toolcall_delta":
				this.currentOutputChars += event.delta.length;
				this.phase = undefined;
				this.idleVerbAllowed = true;
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
				if (event.type !== "toolcall_end") this.idleVerbAllowed = true;
				break;
		}
	}

	complete(message: AssistantMessage): void {
		const estimatedTokens = estimateTokens(this.currentOutputChars);
		this.completedOutputTokens += message.usage.output > 0 ? message.usage.output : estimatedTokens;
		this.currentOutputChars = 0;
		this.phase = undefined;
		this.idleVerbAllowed = true;
	}

	snapshot(now = Date.now()): WorkingOutputSnapshot {
		return {
			elapsedSeconds: Math.max(0, Math.floor((now - this.startedAt) / 1000)),
			outputTokens: this.completedOutputTokens + estimateTokens(this.currentOutputChars),
			phase: this.phase,
			idleVerbAllowed: this.idleVerbAllowed,
		};
	}
}

/**
 * The working row only names real actions: an active tool's verb, "Thinking..."
 * while the model reasons, and a plain "Working..." for the gaps in between.
 * Mood verbs that rotate on a timer were removed — they impersonated actions
 * (a timer-swapped "Reading..." collides with the real one) and made the row
 * read as noise instead of state.
 */
const STEP_WORKING_IDLE_VERB = "Working...";
const STEP_WORKING_VERB_INTERVAL_MS = 4000;

/**
 * When a tool is actually running, the working row should say what it is doing
 * instead of a mood verb — Reading... while read runs, Running... for bash.
 * Unmapped tools fall back to the rotation rather than guessing.
 */
const STEP_TOOL_VERBS: Readonly<Record<string, string>> = {
	// 内置名（STEP_NATIVE_TOOL_NAMES）
	bash: "Running...",
	read: "Reading...",
	write: "Writing...",
	edit: "Editing...",
	grep: "Searching...",
	find: "Finding...",
	ls: "Listing...",
	// step 皮肤对外的重命名（tool-profile.ts）
	run_command: "Running...",
	read_file: "Reading...",
	write_file: "Writing...",
	edit_file: "Editing...",
	search_files: "Searching...",
	find_files: "Finding...",
	list_directory: "Listing...",
	// step 一等扩展工具：长时间运行，值得被点名（评审 L9）
	search_web: "Searching...",
};

/** Pick the honest verb for an active tool; undefined keeps the rotation. */
export function workingVerbForTool(toolName: string | undefined): string | undefined {
	if (!toolName) return undefined;
	return STEP_TOOL_VERBS[toolName];
}

/** Spinner paint alternates between text and muted on each verb tick — the
 * rotation keeps its color motion, but no longer claims the brand purple
 * (anchors stay on tool rows: name + path). */
const STEP_SPINNER_PULSE_COLORS: readonly ["text", "muted"] = ["text", "muted"];

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
	private verbTimer: ReturnType<typeof setInterval> | null = null;
	private verbIndex = 0;
	private statusTip: string | undefined;
	private waitingForApproval = false;
	private disposed = false;
	private readonly requestRender: () => void;

	constructor(
		ui: TUI,
		message: string,
		indicator?: WorkingIndicatorOptions,
		presentation: "native" | "step" = "native",
		outputTracker?: WorkingOutputTracker,
		toolNamer?: () => string | undefined,
	) {
		super(
			"working",
			ui,
			// 工作行 spinner 用中性白——紫只锚在工具行与门面，不再占常驻状态行
			(spinner) => theme.fg("text", spinner),
			(text) => theme.fg("muted", text),
			message,
			indicator,
			presentation,
		);
		this.outputTracker = outputTracker;
		this.toolNamer = toolNamer;
		this.requestRender = () => ui.requestRender();
		this.startVerbTimer();
	}

	/** Temporary presentation state; the saved working message and frames stay intact. */
	setWaitingForApproval(waiting: boolean): void {
		if (this.disposed || this.waitingForApproval === waiting) return;
		this.waitingForApproval = waiting;
		if (waiting) {
			this.stop();
			this.stopVerbTimer();
		} else {
			this.start();
			this.startVerbTimer();
		}
		this.requestRender();
	}

	// Loader.setIndicator calls start(). Store preference changes during a wait
	// without allowing that call to restart the animation (or a disposed row).
	override start(): void {
		if (this.waitingForApproval || this.disposed) return;
		super.start();
	}

	private startVerbTimer(): void {
		if (this.presentation === "step" && this.outputTracker && this.verbTimer === null) {
			this.verbTimer = setInterval(() => this.rotateWorkingVerb(), STEP_WORKING_VERB_INTERVAL_MS);
		}
	}

	private stopVerbTimer(): void {
		if (this.verbTimer === null) return;
		clearInterval(this.verbTimer);
		this.verbTimer = null;
	}

	/** Reads the most recently started still-running tool, when wired. */
	private readonly toolNamer: (() => string | undefined) | undefined;

	/**
	 * Advances the rotating verb (or holds "Thinking..." while the model
	 * reasons). The spinner color pulses between text and muted on the same
	 * tick so the palette shift reads as one motion, not two.
	 */
	private rotateWorkingVerb(): void {
		const snapshot = this.outputTracker?.snapshot();
		if (!snapshot) return;
		const pulseColor = STEP_SPINNER_PULSE_COLORS[this.verbIndex % STEP_SPINNER_PULSE_COLORS.length]!;
		this.verbIndex += 1;
		this.setSpinnerColor((spinner: string) => theme.fg(pulseColor, spinner));
		// Priority: a running tool names the action (the model is not reasoning
		// while a tool runs, even if a stale phase says so) → thinking → honest
		// "Working..." — never a timer-swapped mood verb.
		const toolVerb = workingVerbForTool(this.toolNamer?.());
		if (toolVerb !== undefined) {
			this.setMessage(toolVerb);
			return;
		}
		// 工具已结束但模型还没有新输出：保持当前动词（工具动词黏性），
		// 否则瞬时工具的动词只在一个随机 0-4s 的 tick 相位切片里可见。
		// 黏性期间残留的 thinking 相位也不得覆盖（read 常紧跟 thinking 发起）。
		if (!snapshot.idleVerbAllowed) return;
		if (snapshot.phase === "thinking") {
			this.setMessage("Thinking...");
			return;
		}
		this.setMessage(STEP_WORKING_IDLE_VERB);
	}

	/**
	 * Re-evaluate the verb immediately — called when a tool starts or ends so
	 * short tools (read/grep finish in ~1s) never live and die between the 4s
	 * rotation ticks without ever being named.
	 */
	refreshVerb(): void {
		if (this.verbTimer !== null) this.rotateWorkingVerb();
	}

	/** 本轮展示的 tip（工作行下一行，dim 色）；undefined 则不占行。一轮一条。 */
	setStatusTip(tip: string | undefined): void {
		this.statusTip = tip?.trim() ? tip : undefined;
	}

	override render(width: number): string[] {
		if (this.waitingForApproval) {
			const line = truncateToWidth(` ${theme.fg("muted", "Waiting for approval…")}`, width, "", false);
			return this.presentation === "step" ? [line] : ["", line];
		}
		const lines = super.render(width);
		if (this.presentation !== "step" || !this.outputTracker) return lines;

		const snapshot = this.outputTracker.snapshot();
		const phase = snapshot.phase ? ` · ${snapshot.phase}` : "";
		const suffix = theme.fg(
			"muted",
			` (${formatElapsedTime(snapshot.elapsedSeconds)} · ↓ ${formatTokens(snapshot.outputTokens)} tokens${phase})`,
		);
		const workingLine = `${(lines[0] ?? "").trimEnd()}${suffix}`;
		const rows = [visibleWidth(workingLine) > width ? truncateToWidth(workingLine, width, "", false) : workingLine];
		if (this.statusTip) {
			const tipLine = `  ${theme.fg("dim", `tip: ${this.statusTip}`)}`;
			rows.push(visibleWidth(tipLine) > width ? truncateToWidth(tipLine, width, "", false) : tipLine);
		}
		return rows;
	}

	override dispose(): void {
		this.disposed = true;
		this.stopVerbTimer();
		super.dispose();
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

/**
 * 轮次结束标记：agent_end 后顶替工作状态行，显示这轮耗时与完成时刻，
 * 直到下一轮 turn_start 被清掉——信息流由此获得 CC 式的"呼吸节拍"。
 * 中止/出错轮次不显示（信息流里已有错误行，Done 反而说谎）。
 */
export class TurnDoneIndicator implements Component {
	private readonly line: string;

	constructor(durationSeconds: number, completedAt: Date = new Date()) {
		const clock = `${String(completedAt.getHours()).padStart(2, "0")}:${String(completedAt.getMinutes()).padStart(2, "0")}`;
		// 亚秒轮次如实写 <1s，不写 0s（那是"没花时间"的谎报）
		const duration = durationSeconds < 1 ? "<1s" : formatElapsedTime(durationSeconds);
		this.line = `${theme.fg("accent", "✻")} ${theme.fg("muted", `Done in ${duration} · ${clock}`)}`;
	}

	invalidate(): void {
		// Static one-liner; nothing to invalidate.
	}

	render(width: number): string[] {
		return [visibleWidth(this.line) > width ? truncateToWidth(this.line, width, "", false) : this.line];
	}
}
