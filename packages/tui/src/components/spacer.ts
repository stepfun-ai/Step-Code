import { type Component, isIncrementalRenderDisabled } from "../tui.ts";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;
	private cache?: { lines: number; rendered: string[] };

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	setLines(lines: number): void {
		this.lines = lines;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(_width: number): string[] {
		// A stable array lets the parent container skip the whole transcript above it.
		// Gated like every other cache here so disabling incremental rendering produces the
		// cache-free baseline the render equivalence test compares against.
		const cache = this.cache;
		if (!isIncrementalRenderDisabled() && cache !== undefined && cache.lines === this.lines) {
			return cache.rendered;
		}
		const rendered: string[] = [];
		for (let i = 0; i < this.lines; i++) {
			rendered.push("");
		}
		this.cache = { lines: this.lines, rendered };
		return rendered;
	}
}
