/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { DynamicBorder, keyHint, rawKeyHint, theme } from "@step-harness/coding-agent";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
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
	/**
	 * Show a search row above the list and filter it as the user types.
	 *
	 * Use it for lists whose length is set by the environment rather than by the
	 * dialog — a marketplace can carry hundreds of plugins, and scrolling is not
	 * a way to find one. Movement keys still drive the list; everything else goes
	 * to the search row, so a query never has to be prefixed with a mode key.
	 */
	searchable?: boolean;
}

export class ExtensionSelectorComponent extends Container {
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
	private readonly searchInput: Input | undefined;
	private readonly allItems: SelectItem[];

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

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
		this.allItems = items;
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
			const index = this.visibleItems().indexOf(item);
			if (index >= 0) this.selectedIndex = index;
		};

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		if (opts?.searchable) {
			this.searchInput = new Input();
			// Enter in the search row means "take the highlighted plugin", the same
			// as Enter anywhere else here; the list owns the actual selection.
			this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
			this.addChild(this.searchInput);
			this.addChild(new Spacer(1));
		}

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

	/** The items the list is currently showing, which the search row re-filters. */
	private visibleItems(): SelectItem[] {
		const query = this.searchInput?.getValue() ?? "";
		return query.trim() ? fuzzyFilter(this.allItems, query, (item) => item.value) : this.allItems;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
			return;
		}

		const searchInput = this.searchInput;
		const drivesList =
			kb.matches(keyData, "tui.select.up") ||
			kb.matches(keyData, "tui.select.down") ||
			kb.matches(keyData, "tui.select.pageUp") ||
			kb.matches(keyData, "tui.select.pageDown") ||
			kb.matches(keyData, "tui.select.confirm") ||
			kb.matches(keyData, "tui.select.cancel");

		if (searchInput && !drivesList) {
			searchInput.handleInput(keyData);
			this.applySearch();
			return;
		}

		// Pi's SelectList owns regular movement/confirm/cancel. Step only keeps
		// the product's non-circular boundary behavior for transient decisions, and
		// a search row owns the movement keys instead once one is present.
		if (this.presentation === "step" && !searchInput) {
			const atFirst = this.selectedIndex === 0;
			const atLast = this.selectedIndex === Math.max(0, this.allItems.length - 1);
			if ((kb.matches(keyData, "tui.select.up") && atFirst) || (kb.matches(keyData, "tui.select.down") && atLast)) {
				return;
			}
		}
		this.selectList.handleInput(keyData);
	}

	/**
	 * Push the current query onto the list.
	 *
	 * The selector drives the list through setItems rather than setFilter, so an
	 * empty match set has to be preserved deliberately: setItems with the full
	 * list would resurrect every option the query just excluded.
	 */
	private applySearch(): void {
		const query = this.searchInput?.getValue() ?? "";
		this.selectList.setItems(this.visibleItems());
		if (query.trim() && this.visibleItems().length === 0) this.selectList.setEmpty();
		this.selectedIndex = 0;
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
		if (this.searchInput) {
			rows.push(theme.fg("muted", "Search:"));
			rows.push(...this.searchInput.render(contentWidth));
			rows.push("");
		}
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
						keyHint("tui.select.cancel", "cancel") +
						(this.searchInput ? "  type to search" : ""),
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
