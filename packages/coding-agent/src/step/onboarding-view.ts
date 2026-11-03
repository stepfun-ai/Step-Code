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
	wrapTextWithAnsi,
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
	onRetryPlan?(): void;
	onOpenPlan?(): void;
	requestRender(): void;
}

/** Shared login page used by `step login`, startup onboarding and `/login`. */
export class StepOnboardingView extends Container implements Component, Focusable {
	private readonly profiles: readonly StepLoginProfile[];
	private readonly callbacks: StepOnboardingViewCallbacks;
	private readonly selectList: SelectList;
	private readonly planActions: SelectList;
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
		this.planActions = new SelectList(
			[
				{ value: "key", label: "1. Use an API key" },
				{ value: "subscribe", label: "2. Open Step Plan subscription page" },
				{ value: "retry", label: "3. Check again" },
				{ value: "account", label: "4. Change account or login method" },
			],
			4,
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("muted", text),
				noMatch: (text) => theme.fg("muted", text),
			},
		);
		this.planActions.onSelect = (item) => {
			if (this.step.kind !== "planRequired") return;
			if (item.value === "key")
				this.callbacks.onChoose(this.step.choice === "step_plan_oversea" ? "platform_oversea" : "platform_cn");
			else if (item.value === "subscribe") this.callbacks.onOpenPlan?.();
			else if (item.value === "retry") this.callbacks.onRetryPlan?.();
			else this.callbacks.onBack();
		};
		this.planActions.onCancel = () => this.callbacks.onQuit();

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
		if (step.kind === "planRequired" && this.step.kind !== step.kind) this.planActions.setSelectedIndex(0);
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
		if (this.step.kind === "planRequired") {
			if (data === "q") this.callbacks.onQuit();
			else if (/^[1-4]$/u.test(data)) {
				this.planActions.setSelectedIndex(Number(data) - 1);
				this.planActions.handleInput("\r");
			} else this.planActions.handleInput(data);
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
		if (
			(this.step.kind === "continueInBrowser" || this.step.kind === "checkingPlan") &&
			keybindings.matches(data, "tui.select.cancel")
		) {
			this.callbacks.onBack();
		}
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const rows = this.renderRows(safeWidth);
		// In particular, never truncate the authorization URL or its query string.
		// Remote users need every character, including on a narrow terminal.
		if (this.step.kind === "continueInBrowser" || this.step.kind === "planRequired") {
			return rows.flatMap((row) => wrapTextWithAnsi(row, safeWidth));
		}
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
			case "apiKeyEntry": {
				const choice = this.step.choice;
				rows.push(
					"Use your own API key for usage-based billing",
					muted(this.profiles.find((profile) => profile.id === choice)?.title ?? ""),
					"",
					"Paste or type your API key below. It is stored locally, outside config.json.",
					"",
				);
				rows.push(`  API key: ${this.input.render(Math.max(1, width - 12))[0] ?? ""}`);
				if (this.step.error) rows.push(theme.fg("error", this.step.error));
				rows.push("", muted("  Enter submit · Esc back"));
				return rows;
			}
			case "continueInBrowser":
				rows.push(
					"Continue sign-in in your browser:",
					"",
					// On its own unindented row, wrapping rather than truncating.
					theme.fg("accent", this.step.authUrl || "Opening sign-in page..."),
				);
				rows.push("", muted("If the browser does not open here, copy this URL into a browser on any device."));
				rows.push("", muted("  Esc cancel"));
				return rows;
			case "saving":
				rows.push(muted("Saving credentials..."));
				return rows;
			case "checkingPlan":
				rows.push(muted("Checking Step Plan subscription and available credits..."), "", muted("  Esc back"));
				return rows;
			case "planRequired": {
				const choice = this.step.choice;
				const profile = this.profiles.find((profile) => profile.id === choice);
				rows.push(
					theme.fg("warning", "No active Step Plan subscription or usable top-up credits."),
					muted(this.step.choice === "step_plan_oversea" ? "Account region: Global" : "Account region: CN"),
					"",
					...this.planActions.render(Math.max(1, width - 2)),
					"",
					profile ? theme.fg("accent", `${profile.authBaseUrl}/step-plan`) : "",
					muted("  ↑/↓ select · Enter continue · Esc/q quit"),
				);
				return rows;
			}
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
