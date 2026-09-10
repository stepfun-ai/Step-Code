/**
 * 工作状态行下方的一行小 tip（与 CC 的 spinner tips 同位同用途）。
 * 差异：CC 秒级轮换（社区抱怨没看清就滚走），我们一轮一条、下轮换下一条。
 * 池子小而精，只放高价值入口，不做语境推断（保持笨而稳）。
 */

import { keyText } from "./keybinding-hints.ts";

export function buildStatusTips(): string[] {
	return [
		"Use /theme to switch themes (step / step-light)",
		"Use /model to switch models",
		`Press ${keyText("app.tools.expand")} to expand tool output`,
		"Type @ to autocomplete file paths",
		"Press Enter while working to queue a message",
	];
}

/**
 * 每轮取一条：固定从池头（/theme，用户拍板每次会话首条）开始，顺序推进。
 * 一轮内不换、相邻两轮不重复同一条（池长 ≥2 时）。
 */
export class StatusTipRotator {
	private readonly pool: readonly string[];
	private index: number;

	// Parameter properties are off (erasableSyntaxOnly) — assign explicitly.
	constructor(pool: readonly string[], startIndex = 0) {
		this.pool = pool;
		this.index = pool.length > 0 ? startIndex % pool.length : 0;
	}

	next(): string | undefined {
		if (this.pool.length === 0) return undefined;
		const tip = this.pool[this.index % this.pool.length];
		this.index += 1;
		return tip;
	}
}
