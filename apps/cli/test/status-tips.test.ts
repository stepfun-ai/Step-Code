import { describe, expect, test } from "vitest";
import { buildStatusTips, StatusTipRotator } from "../src/ui/view/chrome/status-tips.ts";

describe("goal-aware status tips", () => {
	test("makes four active commands frequent without adjacent repeats", () => {
		const tips = buildStatusTips("active");
		for (const command of ["status", "pause", "edit", "clear"]) {
			expect(tips.filter((tip) => tip.includes(`/goal ${command}`))).toHaveLength(5);
		}
		expect(tips.filter((tip) => tip.includes("/goal"))).toHaveLength(20);
		for (let index = 0; index < tips.length; index++) expect(tips[index]).not.toBe(tips[(index + 1) % tips.length]);
	});

	test("prioritizes resume while paused, discovery without a goal, and truthful budget guidance", () => {
		expect(buildStatusTips("paused")[0]).toContain("/goal resume");
		expect(buildStatusTips("budget_limited").join(" ")).not.toContain("/goal resume");
		expect(buildStatusTips().join(" ")).toContain("long-running task");
	});

	test("resets on status changes but keeps rotating on equivalent pools", () => {
		const rotator = new StatusTipRotator(buildStatusTips("active"));
		expect(rotator.next()).toContain("/goal status");
		expect(rotator.next(buildStatusTips("active"))).toContain("/goal pause");
		expect(rotator.next(buildStatusTips("paused"))).toContain("/goal resume");
		expect(rotator.next(buildStatusTips("paused"))).toContain("/theme");
		expect(rotator.next(buildStatusTips())).toContain("/theme");
	});
});
