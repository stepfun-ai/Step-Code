import { type Component, isIncrementalRenderDisabled } from "@step-harness/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;
	private cache?: { width: number; lines: string[] };

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		// The color function reads the active theme, so a theme change must drop it.
		this.cache = undefined;
	}

	render(width: number): string[] {
		// A stable array lets the parent container skip everything above it.
		const cache = this.cache;
		if (!isIncrementalRenderDisabled() && cache !== undefined && cache.width === width) {
			return cache.lines;
		}
		const lines = [this.color("─".repeat(Math.max(1, width)))];
		this.cache = { width, lines };
		return lines;
	}
}
