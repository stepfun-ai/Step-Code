import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
} from "@step-harness/pi-tui";
import { DynamicBorder } from "../render/dynamic-border.ts";
import { initTheme, theme } from "../theme/theme.ts";
import type { StepLoginProfile, StepLoginStep } from "./onboarding.ts";

export interface StepOnboardingViewCallbacks {
	onChoose(choice: StepLoginProfile["id"]): void;
	onSubmitApiKey(value: string): void;
	onType(text: string): void;
	onBackspace(): void;
	onBack(): void;
	onQuit(): void;
	requestRender(): void;
}

/** Shared login page used by `step login`, startup onboarding and `/login`. */
export class StepOnboardingView extends Container implements Component, Focusable {
	private readonly profiles: readonly StepLoginProfile[];
	private readonly callbacks: StepOnboardingViewCallbacks;
	private readonly selectList: SelectList;
	private readonly input: Input;
	private step: StepLoginStep = { kind: "pickMode", error: null };
	private focusedState = false;

	constructor(profiles: readonly StepLoginProfile[], callbacks: StepOnboardingViewCallbacks) {
		super();
		try {
			theme.fg("text", "");
		} catch {
			initTheme("dark", false);
		}
		this.profiles = profiles;
		this.callbacks = callbacks;
		const items: SelectItem[] = profiles.map((profile, index) => ({
			value: profile.id,
			label: `${index + 1}. ${profile.title}`,
		}));
		this.selectList = new SelectList(items, Math.max(1, items.length), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("muted", text),
			noMatch: (text) => theme.fg("muted", text),
		});
		this.selectList.onSelect = (item) => {
			const profile = this.profiles.find((candidate) => candidate.id === item.value);
			if (profile) this.callbacks.onChoose(profile.id);
		};
		this.selectList.onCancel = () => this.callbacks.onQuit();

		this.input = new Input();
		this.input.onSubmit = (value) => this.callbacks.onSubmitApiKey(value);
		this.input.onEscape = () => this.callbacks.onBack();
		this.rebuild();
	}

	get focused(): boolean {
		return this.focusedState;
	}

	set focused(value: boolean) {
		this.focusedState = value;
		this.input.focused = value && this.step.kind === "apiKeyEntry";
	}

	setStep(step: StepLoginStep): void {
		this.step = step;
		this.input.setValue(step.kind === "apiKeyEntry" ? step.value : "");
		this.input.focused = this.focusedState && step.kind === "apiKeyEntry";
		this.rebuild();
	}

	getStep(): StepLoginStep {
		return this.step;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
			this.callbacks.onQuit();
			return;
		}
		if (this.step.kind === "pickMode") {
			if (data === "q") {
				this.callbacks.onQuit();
				return;
			}
			if (/^[1-9]$/u.test(data)) {
				const index = Number.parseInt(data, 10) - 1;
				if (index >= 0 && index < this.profiles.length) {
					this.selectList.setSelectedIndex(index);
					this.selectList.handleInput("\r");
				}
				return;
			}
			this.selectList.handleInput(data);
			return;
		}
		if (this.step.kind === "apiKeyEntry") {
			if (keybindings.matches(data, "tui.select.cancel")) {
				this.callbacks.onBack();
				return;
			}
			const before = this.input.getValue();
			this.input.handleInput(data);
			const after = this.input.getValue();
			if (after.length > before.length) this.callbacks.onType(after.slice(before.length));
			else if (after.length < before.length) this.callbacks.onBackspace();
			return;
		}
		if (this.step.kind === "continueInBrowser" && keybindings.matches(data, "tui.select.cancel")) {
			this.callbacks.onBack();
		}
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(20, Math.floor(width));
		const rows = this.renderRows(safeWidth);
		return rows.map((row) => truncateToWidth(row, safeWidth, "", false));
	}

	private renderRows(width: number): string[] {
		const muted = (value: string) => theme.fg("muted", value);
		const rows: string[] = [
			theme.fg("accent", theme.bold("Sign in to use Step Plan, or connect an API key for usage-based billing")),
			"",
		];
		switch (this.step.kind) {
			case "pickMode": {
				rows.push("Select a login method:", "");
				const titles = this.selectList.render(Math.max(1, width - 2));
				for (const [index, title] of titles.entries()) {
					rows.push(title, `     ${muted(this.profiles[index]?.description ?? "")}`);
				}
				if (this.step.error) rows.push("", theme.fg("error", this.step.error));
				rows.push("", muted("  ↑/↓ select · Enter continue · q quit"));
				return rows;
			}
			case "apiKeyEntry":
				rows.push(
					"Use your own API key for usage-based billing",
					"",
					"Paste or type your API key below. It is stored locally, outside config.json.",
					"",
				);
				rows.push(`  API key: ${this.input.render(Math.max(1, width - 12))[0] ?? ""}`);
				if (this.step.error) rows.push(theme.fg("error", this.step.error));
				rows.push("", muted("  Enter submit · Esc back"));
				return rows;
			case "continueInBrowser":
				rows.push(
					"Continue sign-in in your browser:",
					"",
					theme.fg("accent", this.step.authUrl || "Opening sign-in page..."),
				);
				rows.push("", muted("  Esc cancel"));
				return rows;
			case "saving":
				rows.push(muted("Saving credentials..."));
				return rows;
			case "done":
			case "exit":
				return [];
		}
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(this.renderRows(100).join("\n"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.callbacks.requestRender();
	}
}
