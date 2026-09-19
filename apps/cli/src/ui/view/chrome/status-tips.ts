/**
 * 工作状态行下方的一行小 tip（与 CC 的 spinner tips 同位同用途）。
 * 差异：CC 秒级轮换（社区抱怨没看清就滚走），我们一轮一条、下轮换下一条。
 * 按当前 goal 状态选择命令提示，不推断用户意图。
 */

import { keyText, type StepGoalStatus } from "@step-harness/coding-agent";

export function buildStatusTips(goalStatus?: StepGoalStatus): string[] {
	const general = [
		"Use /theme to switch themes (step-blue / step-violet)",
		"Use /model to switch models",
		`Press ${keyText("app.tools.expand")} to expand tool output`,
		"Type @ to autocomplete file paths",
		"Press Enter while working to queue a message",
	];
	if (goalStatus === "active") {
		const commands = [
			"Use /goal status to inspect progress and usage",
			"Use /goal pause to pause; /goal resume continues it",
			"Use /goal edit to revise the current objective",
			"Use /goal clear to end the current goal",
		];
		return general.flatMap((tip) => [...commands, tip]);
	}
	if (goalStatus === "paused" || goalStatus === "blocked" || goalStatus === "usage_limited") {
		return general.flatMap((tip) => ["Use /goal resume to continue the current goal", tip]);
	}
	if (goalStatus === "budget_limited") {
		return ["Use /goal edit to revise the goal, or /goal clear to drop it", ...general];
	}
	return [...general, "Use /goal to set a long-running task and keep working across turns"];
}

/**
 * 每轮取一条：固定从池头（/theme，用户拍板每次会话首条）开始，顺序推进。
 * 一轮内不换、相邻两轮不重复同一条（池长 ≥2 时）。
 */
export class StatusTipRotator {
	private pool: readonly string[];
	private index: number;

	// Parameter properties are off (erasableSyntaxOnly) — assign explicitly.
	constructor(pool: readonly string[], startIndex = 0) {
		this.pool = pool;
		this.index = pool.length > 0 ? startIndex % pool.length : 0;
	}

	next(pool: readonly string[] = this.pool): string | undefined {
		if (pool.length !== this.pool.length || pool.some((tip, index) => tip !== this.pool[index])) {
			this.pool = pool;
			this.index = 0;
		}
		if (this.pool.length === 0) return undefined;
		const tip = this.pool[this.index % this.pool.length];
		this.index += 1;
		return tip;
	}
}
