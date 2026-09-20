/**
 * 工作状态行下方的一行小 tip（与 CC 的 spinner tips 同位同用途）。
 * 差异：CC 秒级轮换（社区抱怨没看清就滚走），我们一轮一条、下轮换下一条。
 * 池子小而精，只放高价值入口，不做语境推断（保持笨而稳）。
 */

import { keyText } from "@step-harness/coding-agent";

/** Which goal state the tip pool should teach for. */
export type GoalTipState = "active" | "paused" | "none";

export function buildStatusTips(goal: GoalTipState = "none"): string[] {
	const [theme, model, expand, atFiles, queueMessage] = [
		"Use /theme to switch themes (step / step-light)",
		"Use /model to switch models",
		`Press ${keyText("app.tools.expand")} to expand tool output`,
		"Type @ to autocomplete file paths",
		"Press Enter while working to queue a message",
	];
	if (goal === "active") {
		// Alternate each goal command with a base tip so the controls stay
		// high-frequency while a goal runs; /theme keeps the fixed first slot.
		return [
			theme,
			"Pause the running goal with /goal pause",
			"Check goal progress with /goal status",
			model,
			"Resume a paused goal with /goal resume",
			expand,
			"End the goal early with /goal clear",
			atFiles,
			queueMessage,
		];
	}
	if (goal === "paused") {
		return ["Resume the paused goal with /goal resume", model, expand, atFiles, queueMessage];
	}
	return [theme, "Use /goal to drive long-running tasks", model, expand, atFiles, queueMessage];
}

/**
 * 每轮取一条：固定从池头（/theme，用户拍板每次会话首条）开始，顺序推进。
 * 一轮内不换、相邻两轮不重复同一条（池长 ≥2 时）。
 */
export class StatusTipRotator {
	private readonly pool: () => readonly string[];
	private index: number;

	// Parameter properties are off (erasableSyntaxOnly) — assign explicitly.
	// Pools are normalized to a function so state-aware tips (for example goal
	// controls) re-read every turn without rebuilding the rotator.
	constructor(pool: readonly string[] | (() => readonly string[]), startIndex = 0) {
		this.pool = typeof pool === "function" ? pool : () => pool;
		this.index = startIndex;
	}

	next(): string | undefined {
		const tips = this.pool();
		if (tips.length === 0) return undefined;
		const tip = tips[this.index % tips.length];
		this.index += 1;
		return tip;
	}
}
