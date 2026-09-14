/**
 * Shared animation clock for Step tool rows.
 *
 * Pi's native tool renderers own the content and lifecycle of a tool call, but
 * the Step presentation puts a status glyph in front of every call. Keeping
 * one clock for all rows matches the old Step TUI and avoids one timer per
 * component while a model is running several tools in parallel.
 */

export const STEP_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

// Long-running plans can keep the working UI visible for minutes. A slower
// animation avoids competing with streaming token renders on slower terminals.
export const STEP_SPINNER_INTERVAL_MS = 200;

export interface StepToolSpinnerState {
	readonly frame: string;
	elapsedSeconds(toolCallId: string): number | null;
	/** Name of the most recently started still-running tool, if any. */
	currentToolName?(): string | undefined;
}

/** A lifecycle-owned clock; callers must invoke {@link dispose} on teardown. */
export class StepToolSpinnerClock implements StepToolSpinnerState {
	private frameIndex = 0;
	private pausedAt: number | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly runningSince = new Map<string, number>();
	private readonly runningToolNames = new Map<string, string | undefined>();
	private readonly requestRender: () => void;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	get frame(): string {
		return STEP_SPINNER_FRAMES[this.frameIndex % STEP_SPINNER_FRAMES.length] ?? STEP_SPINNER_FRAMES[0];
	}

	start(toolCallId: string, toolName?: string): void {
		if (toolCallId.length === 0) return;
		if (!this.runningSince.has(toolCallId)) {
			this.runningSince.set(toolCallId, this.pausedAt ?? Date.now());
			this.runningToolNames.set(toolCallId, toolName);
		}
		this.startTimer();
	}

	/** Freeze presentation while approval is pending, without changing tool lifecycle events. */
	setPaused(paused: boolean): void {
		if (paused === (this.pausedAt !== null)) return;
		if (paused) {
			this.pausedAt = Date.now();
			this.stopTimer();
		} else {
			const waitMs = Date.now() - this.pausedAt!;
			for (const [id, started] of this.runningSince) {
				this.runningSince.set(id, started + waitMs);
			}
			this.pausedAt = null;
			this.startTimer();
		}
		this.requestRender();
	}

	stop(toolCallId: string): void {
		this.runningSince.delete(toolCallId);
		this.runningToolNames.delete(toolCallId);
		this.stopWhenIdle();
	}

	/** Stop every active row, resetting the next run to the first frame. */
	clear(): void {
		this.runningSince.clear();
		this.runningToolNames.clear();
		this.stopWhenIdle();
	}

	elapsedSeconds(toolCallId: string): number | null {
		const started = this.runningSince.get(toolCallId);
		if (started === undefined) return null;
		return Math.max(0, Math.floor(((this.pausedAt ?? Date.now()) - started) / 1000));
	}

	currentToolName(): string | undefined {
		let name: string | undefined;
		for (const toolName of this.runningToolNames.values()) name = toolName ?? name;
		return name;
	}

	dispose(): void {
		this.clear();
		this.pausedAt = null;
	}

	private startTimer(): void {
		if (this.timer !== null || this.pausedAt !== null || this.runningSince.size === 0) return;
		this.timer = setInterval(() => {
			this.frameIndex = (this.frameIndex + 1) % STEP_SPINNER_FRAMES.length;
			this.requestRender();
		}, STEP_SPINNER_INTERVAL_MS);
	}

	private stopTimer(): void {
		if (this.timer === null) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	private stopWhenIdle(): void {
		if (this.runningSince.size > 0) return;
		this.stopTimer();
		this.frameIndex = 0;
	}
}
