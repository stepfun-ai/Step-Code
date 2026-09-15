/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { DynamicBorder, keyHint, rawKeyHint, theme } from "@step-harness/coding-agent";
import {
	Container,
	getKeybindings,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
	wrapTextWithAnsi,
} from "@step-harness/pi-tui";
import { CountdownTimer } from "./countdown-timer.ts";
import { renderStepDialogFrame, splitStepDialogTitle } from "./step-dialog.ts";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
	presentation?: "native" | "step";
}

export class ExtensionSelectorComponent extends Container {
	private readonly options: string[];
	private selectedIndex = 0;
	private readonly selectList: SelectList;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private currentTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;
	private readonly presentation: "native" | "step";

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;
		this.currentTitle = title;
		this.presentation = opts?.presentation ?? "native";

		const items: SelectItem[] = options.map((option) => ({
			value: option,
			label: option,
		}));
		this.selectList = new SelectList(items, Math.max(1, Math.min(8, items.length)), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("muted", text),
			noMatch: (text) => theme.fg("muted", text),
		});
		this.selectList.onSelect = (item) => this.onSelectCallback(item.value);
		this.selectList.onCancel = () => this.onCancelCallback();
		this.selectList.onSelectionChange = (item) => {
			const index = items.indexOf(item);
			if (index >= 0) this.selectedIndex = index;
		};

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => {
					this.currentTitle = `${this.baseTitle} (${s}s)`;
					this.titleText.setText(theme.fg("accent", theme.bold(this.currentTitle)));
				},
				() => this.onCancelCallback(),
			);
		}

		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
			return;
		}

		// Pi's SelectList owns regular movement/confirm/cancel. Step only keeps
		// the product's non-circular boundary behavior for transient decisions.
		if (this.presentation === "step") {
			const atFirst = this.selectedIndex === 0;
			const atLast = this.selectedIndex === Math.max(0, this.options.length - 1);
			if ((kb.matches(keyData, "tui.select.up") && atFirst) || (kb.matches(keyData, "tui.select.down") && atLast)) {
				return;
			}
		}
		this.selectList.handleInput(keyData);
	}

	override render(width: number): string[] {
		if (this.presentation !== "step") return super.render(width);

		const safeWidth = Math.max(1, Math.floor(width));
		if (safeWidth < 8) return super.render(safeWidth);
		const { heading, body } = splitStepDialogTitle(this.currentTitle);
		const contentWidth = Math.max(1, safeWidth - 4);
		const rows: string[] = [];
		if (heading.length > 0) rows.push(theme.fg("accent", theme.bold(`● ${heading}`)));
		for (const line of body) rows.push(theme.fg("muted", line));
		if (rows.length > 0) rows.push("");
		rows.push(...this.selectList.render(contentWidth));
		rows.push("");
		rows.push(
			...wrapTextWithAnsi(
				theme.fg(
					"muted",
					rawKeyHint("↑↓", "navigate") +
						"  " +
						keyHint("tui.select.confirm", "select") +
						"  " +
						keyHint("tui.select.cancel", "cancel"),
				),
				contentWidth,
			),
		);
		return renderStepDialogFrame(rows, safeWidth);
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
