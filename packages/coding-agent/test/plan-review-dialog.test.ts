import { setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	PLAN_REVIEW_FEEDBACK_LABEL,
	PlanReviewComponent,
	type PlanReviewResult,
} from "../src/modes/interactive/components/plan-review.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const ENTER = "\r";
const ESCAPE = "";
const DOWN = "[B";
const UP = "[A";
const BACKSPACE = "";

const PLAN = ["# Heading", "", "- first step", "  nested detail", "", "## Last", "done"].join("\n");

function createReview(): { component: PlanReviewComponent; results: PlanReviewResult[]; renders: () => number } {
	const results: PlanReviewResult[] = [];
	let renderRequests = 0;
	const component = new PlanReviewComponent({
		planFilePath: "/tmp/plan.md",
		planContents: PLAN,
		theme,
		onResult: (result) => results.push(result),
		onChange: () => {
			renderRequests += 1;
		},
	});
	component.focused = true;
	return { component, results, renders: () => renderRequests };
}

function plainRows(component: PlanReviewComponent, width = 60): string[] {
	return component.render(width).map((row) => stripTerminalSequences(row));
}

function type(component: PlanReviewComponent, text: string): void {
	for (const char of text) component.handleInput(char);
}

describe("plan review dialog", () => {
	beforeAll(() => {
		initTheme("step");
		setKeybindings(new KeybindingsManager());
	});

	test("shows the plan with a divider above two rows and no frame", () => {
		const { component } = createReview();
		const rows = plainRows(component);

		expect(rows.some((row) => row.startsWith("╭") || row.startsWith("│"))).toBe(false);
		const dividerRow = rows.findIndex((row) => /^─+$/u.test(row));
		expect(dividerRow).toBeGreaterThan(0);
		expect(rows[dividerRow]).toHaveLength(60);
		expect(rows[dividerRow + 1]?.replace("▸", "").trim()).toBe("Execute the plan");
		expect(rows[dividerRow + 2]?.replace("▸", "").trim()).toBe(PLAN_REVIEW_FEEDBACK_LABEL);

		// Everything above the divider is the plan, blank lines and indent included.
		const planRows = rows.slice(0, dividerRow);
		expect(planRows.some((row) => row.includes("# Heading"))).toBe(true);
		expect(planRows.some((row) => row.includes("  nested detail"))).toBe(true);
		expect(planRows.some((row) => row.trim() === "")).toBe(true);
	});

	test("the feedback row becomes an input as soon as the cursor lands on it", () => {
		const { component, results } = createReview();
		// No Enter first: moving down is enough to start typing.
		component.handleInput(DOWN);
		type(component, "split step 3");

		const rows = plainRows(component);
		const feedbackRow = rows.find((row) => row.includes(PLAN_REVIEW_FEEDBACK_LABEL)) ?? "";
		expect(feedbackRow).toContain(`${PLAN_REVIEW_FEEDBACK_LABEL}: split step 3`);
		expect(feedbackRow.trimStart().startsWith("▸")).toBe(true);
		expect(results).toEqual([]);

		component.handleInput(ENTER);
		expect(results).toEqual([{ action: "feedback", text: "split step 3" }]);
	});

	test("the approve row ignores typing and confirms on enter", () => {
		const { component, results } = createReview();
		type(component, "zzz");
		expect(plainRows(component).some((row) => row.includes("zzz"))).toBe(false);

		component.handleInput(ENTER);
		expect(results).toEqual([{ action: "execute" }]);
	});

	test("enter on an empty feedback row does nothing", () => {
		const { component, results } = createReview();
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(results).toEqual([]);

		// Whitespace-only is equally empty.
		type(component, "   ");
		component.handleInput(ENTER);
		expect(results).toEqual([]);

		// And a real note still goes through afterwards.
		type(component, "do it differently");
		component.handleInput(ENTER);
		expect(results).toEqual([{ action: "feedback", text: "do it differently" }]);
	});

	test("escape keeps plan mode from either row", () => {
		for (const keys of [[ESCAPE], [DOWN, ESCAPE]]) {
			const { component, results } = createReview();
			for (const key of keys) component.handleInput(key);
			expect(results).toEqual([{ action: "dismissed" }]);
		}
	});

	test("the hint follows the row and the typed text survives moving away and back", () => {
		const { component } = createReview();
		expect(plainRows(component).at(-1)).toContain("select");

		component.handleInput(DOWN);
		type(component, "keep me");
		expect(plainRows(component).at(-1)).toContain("send");

		component.handleInput(UP);
		const onApproveRow = plainRows(component);
		expect(onApproveRow.at(-1)).toContain("select");
		// The unselected feedback row shows its label, not the draft.
		expect(onApproveRow.some((row) => row.includes("keep me"))).toBe(false);

		component.handleInput(DOWN);
		component.handleInput(BACKSPACE);
		expect(plainRows(component).some((row) => row.includes(`${PLAN_REVIEW_FEEDBACK_LABEL}: keep m`))).toBe(true);
	});

	test("selection stops at both ends instead of wrapping", () => {
		const { component, results } = createReview();
		component.handleInput(UP);
		component.handleInput(ENTER);
		expect(results).toEqual([{ action: "execute" }]);

		const second = createReview();
		second.component.handleInput(DOWN);
		second.component.handleInput(DOWN);
		type(second.component, "still here");
		second.component.handleInput(ENTER);
		expect(second.results).toEqual([{ action: "feedback", text: "still here" }]);
	});

	test("every rendered row fits the requested width", () => {
		for (const keys of [[], [DOWN, ...["a very long note that will not fit"]]]) {
			const { component } = createReview();
			for (const key of keys) component.handleInput(key);
			for (const width of [20, 40, 60, 120]) {
				for (const row of component.render(width)) {
					expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				}
			}
		}
	});
});
