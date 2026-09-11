import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BIRD_ANIMATION_DURATION_MS, StepWelcomeComponent } from "../src/ui/view/chrome/step-welcome.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";

afterEach(() => {
	initTheme("dark");
});

describe("StepWelcomeComponent", () => {
	it("renders the branded rounded identity block", () => {
		initTheme("step");
		const component = new StepWelcomeComponent(() => ({
			version: "0.3.1",
			model: "step-model",
			thinkingLevel: "high",
			workspaceRoot: "/tmp/project",
		}));
		component.setFirstMessageHint(true);
		const lines = component.render(80);

		expect(lines[0]).toContain("╭");
		expect(lines.join("\n")).toContain("Step CLI");
		expect(lines.join("\n")).toContain("step-model");
		expect(lines.join("\n")).toContain("step-model · high");
		expect(lines.at(-2)).toContain("Your first message will start a new session.");
		for (const line of lines.slice(0, -2)) {
			if (line.length > 0) expect(visibleWidth(line)).toBe(80);
		}
	});

	it("shows reasoning off explicitly", () => {
		initTheme("step");
		const component = new StepWelcomeComponent(() => ({
			model: "step-model",
			thinkingLevel: "off",
			workspaceRoot: "/tmp/project",
		}));

		const output = component.render(80).join("\n");
		expect(output).toContain("step-model · reasoning: off");
		expect(output).not.toContain("step-model · off");
	});

	it("removes the first-session hint after a message is projected", () => {
		initTheme("step");
		const component = new StepWelcomeComponent(() => ({
			workspaceRoot: "/tmp/project",
		}));
		component.setFirstMessageHint(true);
		expect(component.render(40).join("\n")).toContain("Your first message");
		component.setFirstMessageHint(false);
		expect(component.render(40).join("\n")).not.toContain("Your first message");
	});

	it("requests a render when visibility state changes", () => {
		initTheme("step");
		let renderRequests = 0;
		const component = new StepWelcomeComponent(() => ({ workspaceRoot: "/tmp/project" }), {
			requestRender: () => renderRequests++,
		});

		component.setFirstMessageHint(true);
		component.setFirstMessageHint(true);
		component.setVisible(false);
		component.setVisible(false);
		component.setVisible(true);

		expect(renderRequests).toBe(3);
	});

	it("stops the logo intro early and settles on the static logo", () => {
		initTheme("step");
		vi.useFakeTimers();
		try {
			let renderRequests = 0;
			const component = new StepWelcomeComponent(() => ({ workspaceRoot: "/tmp/project" }), {
				requestRender: () => renderRequests++,
			});

			component.playLogoIntro();
			vi.advanceTimersByTime(400);
			const duringIntro = renderRequests;
			expect(duringIntro).toBeGreaterThan(1);
			const animated = component.render(80).join("\n");

			component.stopLogoIntro();
			expect(renderRequests).toBe(duringIntro + 1);
			const settled = component.render(80).join("\n");
			expect(settled).not.toBe(animated);

			// Every remaining frame would have cost a render. None are left.
			vi.advanceTimersByTime(BIRD_ANIMATION_DURATION_MS * 2);
			expect(renderRequests).toBe(duringIntro + 1);
			expect(component.render(80).join("\n")).toBe(settled);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does nothing when stopping an intro that never played", () => {
		initTheme("step");
		let renderRequests = 0;
		const component = new StepWelcomeComponent(() => ({ workspaceRoot: "/tmp/project" }), {
			requestRender: () => renderRequests++,
		});

		component.stopLogoIntro();
		expect(renderRequests).toBe(0);
	});

	it("does not overflow a very narrow terminal", () => {
		initTheme("step");
		const component = new StepWelcomeComponent(() => ({
			workspaceRoot: "/tmp/project",
		}));
		for (const width of [1, 4, 7, 8, 11]) {
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
