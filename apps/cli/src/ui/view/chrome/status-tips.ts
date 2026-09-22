/**
 * The single rotating tip line under the working-status row (same slot and
 * purpose as Claude Code's spinner tips). Unlike CC's second-level rotation,
 * which users complain scrolls by unread, one tip serves a whole turn and the
 * next turn takes the next one. Goal-command tips follow the current goal
 * status without inferring user intent.
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
 * One tip per turn: the pool always starts from its head (/theme — the agreed
 * first tip of every session) and advances in order. A tip never changes
 * mid-turn, and consecutive turns never repeat the same tip (pools of ≥2).
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
