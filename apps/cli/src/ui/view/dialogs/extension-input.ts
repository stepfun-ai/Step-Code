/**
 * Simple text input component for extensions.
 */

import { DynamicBorder, keyHint, theme } from "@step-harness/coding-agent";
import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@step-harness/pi-tui";
import { CountdownTimer } from "./countdown-timer.ts";
import { renderStepDialogFrame, splitStepDialogTitle } from "./step-dialog.ts";

export interface ExtensionInputOptions {
	tui?: TUI;
	timeout?: number;
	presentation?: "native" | "step";
}

export class ExtensionInputComponent extends Container implements Focusable {
	private input: Input;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private currentTitle: string;
	private countdown: CountdownTimer | undefined;
	private readonly placeholder: string | undefined;
	private readonly presentation: "native" | "step";

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		title: string,
		placeholder: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		opts?: ExtensionInputOptions,
	) {
		super();

		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;
		this.baseTitle = title;
		this.currentTitle = title;
		this.placeholder = placeholder;
		this.presentation = opts?.presentation ?? "native";

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(theme.fg("accent", title), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => {
					this.currentTitle = `${this.baseTitle} (${s}s)`;
					this.titleText.setText(theme.fg("accent", this.currentTitle));
				},
				() => this.onCancelCallback(),
			);
		}

		this.input = new Input();
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`, 1, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.onSubmitCallback(this.input.getValue());
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			this.input.handleInput(keyData);
		}
	}

	dispose(): void {
		this.countdown?.dispose();
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

		let inputLine = this.input.render(contentWidth)[0] ?? "> ";
		if (this.input.getValue().length === 0 && this.placeholder) {
			// Keep the native cursor and editing state, adding only a muted visual
			// hint in the otherwise empty row.
			const hint = theme.fg("dim", this.placeholder);
			inputLine = `${inputLine} ${hint}`;
		}
		rows.push(inputLine);
		rows.push("");
		rows.push(
			theme.fg("muted", `${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`),
		);
		return renderStepDialogFrame(rows, safeWidth);
	}
}
