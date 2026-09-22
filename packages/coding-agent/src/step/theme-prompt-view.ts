/**
 * First-run theme picker screen.
 *
 * The list alone cannot answer the question it asks — "which of these reads
 * best in *this* terminal?" — so every move repaints a sample below it: a
 * heading, body and muted line for the interface colors, and a small diff for
 * the syntax and diff colors, which is what most of a coding session looks
 * like. The surrounding UI recolors at the same time, because the preview is
 * the real theme being applied, not a mock-up of one.
 */

import {
	type Component,
	Container,
	type Focusable,
	matchesKey,
	type SelectItem,
	SelectList,
	truncateToWidth,
} from "@step-harness/pi-tui";
import { keyHint, rawKeyHint } from "../render/keybinding-hints.ts";
import { highlightCode, initTheme, theme } from "../theme/theme.ts";
import type { StepThemeOption } from "./theme-prompt.ts";

export interface StepThemePromptViewCallbacks {
	/** Setting to preselect; ignored when it is not one of the options. */
	readonly initialSetting?: string;
	onPreview(setting: string): void;
	onConfirm(setting: string): void;
	onCancel(): void;
	requestRender(): void;
}

const MAX_VISIBLE_ROWS = 9;

/** Preview sample: unchanged lines are syntax-highlighted, the pair is a diff. */
const PREVIEW_CONTEXT_OPEN = "function greet() {";
const PREVIEW_REMOVED = '  console.log("Hello, World!");';
const PREVIEW_ADDED = '  console.log("Hello, Step!");';
const PREVIEW_CONTEXT_CLOSE = "}";

export class StepThemePromptView extends Container implements Component, Focusable {
	private readonly options: readonly StepThemeOption[];
	private readonly callbacks: StepThemePromptViewCallbacks;
	private readonly selectList: SelectList;
	private focusedState = false;

	constructor(options: readonly StepThemeOption[], callbacks: StepThemePromptViewCallbacks) {
		super();
		// The screen can be mounted before any other renderer has initialized a
		// theme; without one, every theme.fg() call below would throw.
		try {
			theme.fg("text", "");
		} catch {
			initTheme("dark", false);
		}
		this.options = options;
		this.callbacks = callbacks;

		const items: SelectItem[] = options.map((option, index) => ({
			value: option.setting,
			label: `${index + 1}. ${option.label}`,
			description: option.description,
		}));
		this.selectList = new SelectList(items, Math.min(MAX_VISIBLE_ROWS, Math.max(1, items.length)), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("muted", text),
			noMatch: (text) => theme.fg("muted", text),
		});

		const initialIndex = options.findIndex((option) => option.setting === callbacks.initialSetting);
		if (initialIndex !== -1) this.selectList.setSelectedIndex(initialIndex);

		this.selectList.onSelectionChange = (item) => {
			this.callbacks.onPreview(item.value);
			this.callbacks.requestRender();
		};
		this.selectList.onSelect = (item) => this.callbacks.onConfirm(item.value);
		this.selectList.onCancel = () => this.callbacks.onCancel();
	}

	get focused(): boolean {
		return this.focusedState;
	}

	set focused(value: boolean) {
		this.focusedState = value;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
			this.callbacks.onCancel();
			return;
		}
		if (/^[1-9]$/u.test(data)) {
			const index = Number.parseInt(data, 10) - 1;
			if (index < this.options.length) {
				this.selectList.setSelectedIndex(index);
				this.callbacks.onPreview(this.options[index].setting);
				this.callbacks.onConfirm(this.options[index].setting);
			}
			return;
		}
		this.selectList.handleInput(data);
		this.callbacks.requestRender();
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(20, Math.floor(width));
		return this.renderRows(safeWidth).map((row) => truncateToWidth(row, safeWidth, "", false));
	}

	private renderRows(width: number): string[] {
		const muted = (value: string) => theme.fg("muted", value);
		const rows: string[] = [
			theme.fg("accent", theme.bold("Choose the text style that looks best with your terminal")),
			muted("To change this later, run /theme"),
			"",
			...this.selectList.render(Math.max(1, width - 2)),
			"",
			...this.renderPreview(width),
			"",
			`  ${rawKeyHint("↑/↓", "select")}  ${keyHint("tui.select.confirm", "continue")}  ${keyHint("tui.select.cancel", "keep the default")}`,
		];
		return rows;
	}

	private renderPreview(width: number): string[] {
		const rule = theme.fg("dim", "┄".repeat(Math.max(4, Math.min(width - 2, 72))));
		const gutter = (value: string) => theme.fg("dim", value);
		return [
			`  ${rule}`,
			`  ${gutter("  ")} ${highlightLine(PREVIEW_CONTEXT_OPEN)}`,
			`  ${gutter("2 ")}${theme.fg("toolDiffRemoved", `-${PREVIEW_REMOVED}`)}`,
			`  ${gutter("2 ")}${theme.fg("toolDiffAdded", `+${PREVIEW_ADDED}`)}`,
			`  ${gutter("  ")} ${highlightLine(PREVIEW_CONTEXT_CLOSE)}`,
			`  ${rule}`,
			`  ${theme.fg("muted", "Assistant text")} ${theme.fg("text", "reads like this;")} ${theme.fg("success", "success")} ${theme.fg("warning", "warning")} ${theme.fg("error", "error")}`,
		];
	}
}

function highlightLine(line: string): string {
	return highlightCode(line, "typescript")[0] ?? line;
}
