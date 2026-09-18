import { DynamicBorder, keyHint, rawKeyHint, theme } from "@step-harness/coding-agent";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@step-harness/pi-tui";
import type { ApiKeyAuth, AuthCheck, OAuthAuth } from "@step-harness/providers";
import { renderStepDialogFrame, splitStepDialogTitle } from "./step-dialog.ts";

export type AuthSelectorProvider = {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
	method?: ApiKeyAuth | OAuthAuth;
	status?: AuthCheck;
};

export interface OAuthSelectorOptions {
	/** Presentation-only shell. Input and selection state stay native. */
	presentation?: "native" | "step";
}

const OAUTH_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 20,
	maxPrimaryColumnWidth: 32,
};

export function formatAuthSelectorProviderType(authType: AuthSelectorProvider["authType"]): string {
	return authType === "oauth" ? "subscription" : "API key";
}

/**
 * Provider selector built from pi-tui's native Input and SelectList.
 *
 * Search remains a small product concern because the provider catalog is
 * filtered with fuzzy matching. Once filtered, all movement, confirmation,
 * cancellation, scrolling, and selection state are delegated to SelectList.
 */
export class OAuthSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private selectList: SelectList;
	private selectListChildIndex: number;
	private readonly allProviders: AuthSelectorProvider[];
	private filteredProviders: AuthSelectorProvider[];
	private selectedIndex = 0;
	private readonly mode: "login" | "logout";
	private readonly onSelectCallback: (providerId: string, authType: AuthSelectorProvider["authType"]) => void;
	private readonly onCancelCallback: () => void;
	private readonly showAuthTypeLabels: boolean;
	private readonly presentation: "native" | "step";
	private readonly title: string;

	// Focusable implementation - propagate to the native search input for IME
	// cursor positioning. SelectList intentionally has no separate focus state.
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		mode: "login" | "logout",
		providers: AuthSelectorProvider[],
		onSelect: (providerId: string, authType: AuthSelectorProvider["authType"]) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		opts?: OAuthSelectorOptions,
	) {
		super();

		this.mode = mode;
		this.allProviders = providers;
		this.filteredProviders = providers;
		this.showAuthTypeLabels = new Set(providers.map((provider) => provider.authType)).size > 1;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.presentation = opts?.presentation ?? "native";
		this.title = mode === "login" ? "Select provider to configure:" : "Select provider to logout:";

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(this.title)), 1, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearchInput) this.searchInput.setValue(initialSearchInput);
		this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.selectList = this.buildSelectList(this.filteredProviders);
		this.selectListChildIndex = this.children.length;
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

		// Use the same fuzzy path for a prefilled query and for later keystrokes.
		this.applyFilter(initialSearchInput ?? "", false);
	}

	private buildSelectList(providers: AuthSelectorProvider[], selectedKey?: string): SelectList {
		const items: SelectItem[] = providers.map((provider) => ({
			value: providerKey(provider),
			label: provider.name,
			description: this.formatProviderDescription(provider),
		}));
		const list = new SelectList(
			items,
			Math.max(1, Math.min(8, items.length)),
			this.getSelectListTheme(),
			OAUTH_SELECT_LIST_LAYOUT,
		);
		if (selectedKey) {
			const selectedIndex = items.findIndex((item) => item.value === selectedKey);
			if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
		}
		list.onSelect = (item) => {
			const provider = providers.find((candidate) => providerKey(candidate) === item.value);
			if (provider) this.onSelectCallback(provider.id, provider.authType);
		};
		list.onCancel = () => this.onCancelCallback();
		list.onSelectionChange = (item) => {
			const index = items.findIndex((candidate) => candidate.value === item.value);
			if (index >= 0) this.selectedIndex = index;
		};
		return list;
	}

	private getSelectListTheme() {
		return {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("muted", text),
			noMatch: (_text: string) => theme.fg("muted", `  ${this.noProvidersMessage()}`),
		};
	}

	private noProvidersMessage(): string {
		if (this.allProviders.length === 0) {
			return this.mode === "login" ? "No providers available" : "No providers logged in. Use /login first.";
		}
		return "No matching providers";
	}

	private formatProviderDescription(provider: AuthSelectorProvider): string {
		const authTypeLabel = this.showAuthTypeLabels ? ` [${formatAuthSelectorProviderType(provider.authType)}]` : "";
		return `${authTypeLabel}${this.formatStatusIndicator(provider)}`;
	}

	private applyFilter(query: string, preserveSelection = true): void {
		const currentProvider = preserveSelection ? this.filteredProviders[this.selectedIndex] : undefined;
		const currentKey = currentProvider ? providerKey(currentProvider) : undefined;
		this.filteredProviders = query
			? fuzzyFilter(
					this.allProviders,
					query,
					(provider) => `${provider.name} ${provider.id} ${provider.authType} ${provider.method?.name ?? ""}`,
				)
			: this.allProviders;
		this.selectList = this.buildSelectList(this.filteredProviders, currentKey);
		this.children[this.selectListChildIndex] = this.selectList;
		const restoredIndex = currentKey
			? this.filteredProviders.findIndex((provider) => providerKey(provider) === currentKey)
			: -1;
		this.selectedIndex = restoredIndex >= 0 ? restoredIndex : 0;
	}

	private formatStatusIndicator(provider: AuthSelectorProvider): string {
		if (!provider.status) return theme.fg("muted", " • unconfigured");
		if (provider.status.type !== provider.authType) {
			const label = provider.status.type === "oauth" ? "subscription configured" : "API key configured";
			return theme.fg("muted", " • ") + theme.fg("warning", label);
		}
		if (
			!provider.status.source ||
			provider.status.source === "OAuth" ||
			provider.status.source === "stored credential"
		) {
			return theme.fg("success", " ✓ configured");
		}
		const source = /^[A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*$/.test(provider.status.source)
			? `env: ${provider.status.source}`
			: provider.status.source;
		return theme.fg("success", ` ✓ ${source}`);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const isUp = kb.matches(keyData, "tui.select.up");
		const isDown = kb.matches(keyData, "tui.select.down");
		const isCancel = kb.matches(keyData, "tui.select.cancel");
		const isNav = isUp || isDown || kb.matches(keyData, "tui.select.confirm") || isCancel;
		if (isNav) {
			if (this.filteredProviders.length === 0) {
				if (isCancel) this.onCancelCallback();
				return;
			}
			// Step keeps the old non-circular boundary behavior; native SelectList
			// owns movement and confirmation everywhere else.
			if (
				this.presentation === "step" &&
				((isUp && this.selectedIndex === 0) || (isDown && this.selectedIndex === this.filteredProviders.length - 1))
			) {
				return;
			}
			this.selectList.handleInput(keyData);
			return;
		}

		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	override render(width: number): string[] {
		if (this.presentation !== "step") return super.render(width);
		const safeWidth = Math.max(1, Math.floor(width));
		if (safeWidth < 8) return super.render(safeWidth);
		const contentWidth = Math.max(1, safeWidth - 4);
		const { heading, body } = splitStepDialogTitle(this.title);
		const rows: string[] = [];
		if (heading) rows.push(theme.fg("accent", theme.bold(`● ${heading}`)));
		for (const line of body) rows.push(theme.fg("muted", line));
		if (rows.length > 0) rows.push("");
		rows.push(...this.searchInput.render(contentWidth));
		rows.push("");
		rows.push(...this.selectList.render(contentWidth));
		rows.push("");
		rows.push(
			theme.fg(
				"muted",
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
			),
		);
		return renderStepDialogFrame(rows, safeWidth);
	}
}

function providerKey(provider: AuthSelectorProvider): string {
	return `${provider.id}\u0000${provider.authType}`;
}
