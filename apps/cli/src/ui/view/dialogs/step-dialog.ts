import { theme } from "@step-harness/coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@step-harness/pi-tui";

/**
 * Presentation-only frame shared by Step's transient dialogs.
 *
 * The rows passed here are already rendered by pi-tui components. Keeping the
 * frame at this boundary means selectors, inputs, and auth prompts retain the
 * native focus/input state machine while sharing one visual treatment.
 */
export function renderStepDialogFrame(rows: readonly string[], width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	if (rows.length === 0) return [];

	// A rounded frame below this width leaves no useful content column. Let the
	// native component render in that case, but still enforce pi-tui's width
	// contract for callers that provide a narrow test terminal.
	if (safeWidth < 8) {
		return rows.map((row) => truncateToWidth(row, safeWidth, "", false));
	}

	const border = (text: string) => theme.fg("borderAccent", text);
	const innerWidth = Math.max(1, safeWidth - 4);
	const rule = "─".repeat(Math.max(0, safeWidth - 2));
	const framed = [border(`╭${rule}╮`)];
	for (const rawRow of rows) {
		const row = visibleWidth(rawRow) > innerWidth ? truncateToWidth(rawRow, innerWidth, "", false) : rawRow;
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(row)));
		framed.push(`${border("│")} ${row}${padding} ${border("│")}`);
	}
	framed.push(border(`╰${rule}╯`));
	return framed;
}

/**
 * Presentation-only shell for selectors that still use Pi's native layout.
 *
 * Selectors are deliberately kept as the focused component: the shell only
 * renders their rows and never receives keyboard input. This lets the native
 * Input/SelectList state machine (including IME cursor markers) stay intact
 * while the Step entry point gets the same rounded chrome as other dialogs.
 */
export class StepSelectorFrame implements Component {
	private readonly child: Component;

	constructor(child: Component) {
		this.child = child;
	}

	/** Expose the wrapped component for diagnostics and focused-tree tests. */
	get wrappedComponent(): Component {
		return this.child;
	}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		if (safeWidth < 8) return this.child.render(safeWidth);

		// Render the focused native component exactly once. Calling render() a
		// second time at a different width is observable for selectors that update
		// their cursor/scroll state while rendering, and it needlessly doubles
		// work on every frame. The Step shell is presentation-only: render the
		// component at the requested width, then crop its rows into our frame.
		const nativeRows = this.child.render(safeWidth);
		// A selector that already opted into the Step presentation (for example
		// OAuthSelectorComponent) returns a rounded frame of its own. Leave it
		// untouched to avoid nested boxes.
		if (hasRoundedFrame(nativeRows)) return clampRows(nativeRows, safeWidth);

		const contentRows = stripNativeOuterRules(nativeRows);
		return renderStepDialogFrame(contentRows, safeWidth);
	}
}

// SGR styling does not change the structural box characters. Keep this
// parser intentionally narrow so arbitrary ANSI payloads remain untouched.
function stripSgr(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replaceAll(/\x1b\[[0-9;]*m/g, "");
}

function isHorizontalRule(line: string): boolean {
	return /^\s*─+\s*$/u.test(stripSgr(line));
}

function isRoundedTop(line: string): boolean {
	return /^\s*╭─*╮\s*$/u.test(stripSgr(line));
}

function isRoundedBottom(line: string): boolean {
	return /^\s*╰─*╯\s*$/u.test(stripSgr(line));
}

function hasRoundedFrame(rows: readonly string[]): boolean {
	return rows.length >= 2 && isRoundedTop(rows[0] ?? "") && isRoundedBottom(rows.at(-1) ?? "");
}

function stripNativeOuterRules(rows: readonly string[]): string[] {
	let start = 0;
	let end = rows.length;
	if (isHorizontalRule(rows[start] ?? "")) start += 1;
	if (end > start && isHorizontalRule(rows[end - 1] ?? "")) end -= 1;
	return rows.slice(start, end);
}

function clampRows(rows: readonly string[], width: number): string[] {
	return rows.map((row) => (visibleWidth(row) > width ? truncateToWidth(row, width, "", false) : row));
}

/** Split a dialog title into its heading and explanatory body. */
export function splitStepDialogTitle(title: string): {
	heading: string;
	body: string[];
} {
	const lines = title.split(/\r\n|\r|\n/u);
	const heading = lines.shift()?.trim() ?? "";
	return {
		heading,
		body: lines.map((line) => line.trim()).filter((line) => line.length > 0),
	};
}
