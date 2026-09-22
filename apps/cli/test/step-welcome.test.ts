import { stripTerminalSequences, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BIRD_FRAME_COUNT, BIRD_FRAME_DURATIONS_MS } from "../src/ui/view/chrome/step-logo.ts";
import { BIRD_ANIMATION_DURATION_MS, StepWelcomeComponent } from "../src/ui/view/chrome/step-welcome.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";

afterEach(() => {
	vi.useRealTimers();
	initTheme("dark");
});

describe("StepWelcomeComponent", () => {
	it("renders the branded rounded identity block", () => {
		initTheme("step-blue");
		const component = new StepWelcomeComponent(() => ({
			version: "0.1.0",
			model: "step-model",
			thinkingLevel: "high",
			workspaceRoot: "/tmp/project",
		}));
		component.setFirstMessageHint(true);
		const lines = component.render(140);

		// Wide terminal: the wordmark strip sits above the framed info box.
		expect(lines[0]).not.toContain("╭");
		expect(lines[10]).toContain("╭");
		expect(lines[10]).toContain("v0.1.0"); // version rides in the border title
		// The wordmark art replaces the literal title text.
		expect(lines.join("\n")).not.toContain("Step CLI");
		expect(lines.join("\n")).toContain("step-model · high");
		expect(lines.join("\n")).toContain("cwd");
		expect(lines.at(-2)).toContain("Your first message will start a new session.");
		for (const line of lines.slice(0, -2)) {
			if (line.length > 0) expect(visibleWidth(line)).toBeLessThanOrEqual(140);
		}
	});

	it("shows reasoning off explicitly", () => {
		initTheme("step-blue");
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
		initTheme("step-blue");
		const component = new StepWelcomeComponent(() => ({
			workspaceRoot: "/tmp/project",
		}));
		component.setFirstMessageHint(true);
		expect(component.render(40).join("\n")).toContain("Your first message");
		component.setFirstMessageHint(false);
		expect(component.render(40).join("\n")).not.toContain("Your first message");
	});

	it("requests a render when visibility state changes", () => {
		initTheme("step-blue");
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
		initTheme("step-blue");
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

	it("rides in dragging the word, loops the pedals, then settles and never replays", () => {
		initTheme("step-blue");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = new StepWelcomeComponent(() => ({ workspaceRoot: "/tmp/project" }), requestRender);
		const staticRows = component.render(140);
		const plain = staticRows.map(stripTerminalSequences).join("\n");
		// The settled strip carries both the bird and the dragged word.
		expect(plain).toContain("▀");
		expect(plain).toContain("▄▄▄▄");

		component.playLogoIntro();
		component.playLogoIntro();
		// During the ride the layout differs from the settled strip and every
		// pedal frame repaints.
		let previous = component.render(140).join("\n");
		expect(previous).not.toBe(staticRows.join("\n"));
		for (let frame = 0; frame < BIRD_FRAME_COUNT; frame++) {
			vi.advanceTimersByTime(BIRD_FRAME_DURATIONS_MS[frame]!);
			const current = component.render(140).join("\n");
			expect(current).not.toBe(previous);
			previous = current;
		}
		// The pedals keep looping inside the ~5s window…
		vi.advanceTimersByTime(BIRD_FRAME_DURATIONS_MS[0]!);
		expect(component.render(140).join("\n")).not.toBe(previous);
		// …and settle once it elapses.
		vi.advanceTimersByTime(10_000);
		expect(component.render(140)).toEqual(staticRows);
		expect(vi.getTimerCount()).toBe(0);
		component.playLogoIntro();
		component.invalidate();
		component.setVisible(false);
		component.setVisible(true);
		requestRender.mockClear();
		vi.advanceTimersByTime(BIRD_ANIMATION_DURATION_MS * 3);
		expect(component.render(140)).toEqual(staticRows);
		expect(requestRender).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not schedule or repaint after disposal", () => {
		initTheme("step-blue");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = new StepWelcomeComponent(() => ({ workspaceRoot: "/tmp/project" }), requestRender);
		component.playLogoIntro();
		vi.advanceTimersByTime(140);
		requestRender.mockClear();
		component.dispose();
		component.dispose();
		component.playLogoIntro();
		vi.advanceTimersByTime(BIRD_ANIMATION_DURATION_MS * 2);
		expect(requestRender).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does nothing when stopping an intro that never played", () => {
		initTheme("step-blue");
		let renderRequests = 0;
		const component = new StepWelcomeComponent(() => ({ workspaceRoot: "/tmp/project" }), {
			requestRender: () => renderRequests++,
		});

		component.stopLogoIntro();
		expect(renderRequests).toBe(0);
	});

	it("does not overflow a very narrow terminal", () => {
		initTheme("step-blue");
		const component = new StepWelcomeComponent(() => ({
			workspaceRoot: "/tmp/project",
		}));
		for (const width of [1, 4, 7, 8, 11, 30, 46, 47, 58, 59, 60, 80, 100]) {
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
