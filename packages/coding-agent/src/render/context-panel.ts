import {
	type Component,
	getKeybindings,
	type KeybindingsManager,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@step-harness/pi-tui";
import {
	type ContextMeterSegment,
	type ContextReport,
	contextMeterSegments,
	contextReportRows,
} from "../step/context-report.ts";
import type { Theme } from "../theme/theme.ts";

export interface ContextPanelOptions {
	report: ContextReport;
	showAll?: boolean;
	theme: Theme;
	tui?: TUI;
	onClose: () => void;
}

const SEGMENT_COLORS: Record<ContextMeterSegment, Parameters<Theme["fg"]>[0]> = {
	instructions: "accent",
	tools: "warning",
	conversation: "success",
	reserve: "dim",
	free: "muted",
};

export function formatContextReportText(report: ContextReport, showAll = false): string {
	const rows = contextReportRows(report, showAll);
	const meter = contextMeterSegments(report)
		.map((segment) => (segment === "free" ? "░" : segment === "reserve" ? "▒" : "█"))
		.join("");
	if (meter) rows.splice(2, 0, meter);
	rows.push("", showAll ? "A summary · Esc close" : "A all details · Esc close");
	return rows.join("\n");
}

/** Read-only current-context report. It never starts a model turn; token totals may come from the provider tokenizer endpoint. */
export class ContextPanel implements Component {
	private readonly options: Required<Pick<ContextPanelOptions, "report" | "theme" | "onClose">> & ContextPanelOptions;
	private readonly keybindings: KeybindingsManager;
	private showAll: boolean;
	private scroll = 0;

	constructor(options: ContextPanelOptions, keybindings: KeybindingsManager = getKeybindings()) {
		this.options = options;
		this.keybindings = keybindings;
		this.showAll = options.showAll ?? false;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || data === "\u0003") {
			this.options.onClose();
			return;
		}
		if (data === "a" || data === "A") {
			this.showAll = !this.showAll;
			this.scroll = 0;
			this.options.tui?.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "pageUp")) {
			this.scroll = Math.max(0, this.scroll - (matchesKey(data, "pageUp") ? 10 : 1));
		} else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "pageDown")) {
			this.scroll += matchesKey(data, "pageDown") ? 10 : 1;
		}
		this.options.tui?.requestRender();
	}

	private meter(width: number): string {
		const theme = this.options.theme;
		return contextMeterSegments(this.options.report, Math.min(40, Math.max(1, width)))
			.map((segment) =>
				theme.fg(SEGMENT_COLORS[segment], segment === "free" ? "░" : segment === "reserve" ? "▒" : "█"),
			)
			.join("");
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const innerWidth = Math.max(1, safeWidth - 2);
		const rows = contextReportRows(this.options.report, this.showAll);
		if (this.options.report.usedTokens !== null && this.options.report.contextWindow > 0) {
			rows.splice(2, 0, this.meter(innerWidth));
		}
		rows.push(
			"",
			this.options.theme.fg("muted", this.showAll ? "A summary · Esc close" : "A all details · Esc close"),
		);
		const wrapped = rows.flatMap((row) => wrapTextWithAnsi(row, innerWidth));
		const height = Math.max(5, (this.options.tui?.terminal.rows ?? wrapped.length + 4) - 6);
		const maxScroll = Math.max(0, wrapped.length - height);
		this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
		return wrapped
			.slice(this.scroll, this.scroll + height)
			.map((row) => ` ${visibleWidth(row) > innerWidth ? truncateToWidth(row, innerWidth, "", false) : row}`);
	}
}
