/**
 * Shell actions with fixed names, callable from any feature. The shell feature
 * owns this file; legacy app.js line numbers are noted per function.
 */

import { t } from "../../i18n";
import type { Locale } from "../../i18n/messages";
import { api, errorMessage } from "../../lib/api";
import { STORAGE_KEYS, writeStorage } from "../../lib/storage";
import { closeStream, showError } from "../../state/session";
import { getState, setState, setUi, type ThemeChoice } from "../../state/store";
import type { LoginReport } from "../../state/types";

const THEMES: readonly ThemeChoice[] = ["system", "light", "dark", "violet"];

/**
 * Where "Upgrade" leads: the Step Plan page of the signed-in account's
 * platform, which the host derives from the stored profile (overseas accounts
 * use platform.stepfun.ai). The mainland page stands in until bootstrap answers.
 */
export function stepPlanUrl(login: LoginReport | null): string {
	return login?.planUrl ?? "https://platform.stepfun.com/step-plan";
}

function systemPrefersDark(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * "light", "dark" or "violet" for a theme choice (legacy `resolvedTheme`, 524-526);
 * "violet" is a light-plane theme of its own, so it passes through unmixed.
 */
export function resolvedTheme(theme: ThemeChoice = getState().theme): "light" | "dark" | "violet" {
	return theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
}

/**
 * Apply and (by default) persist a theme choice (legacy `applyTheme`, 559-564).
 * Writes `<html data-theme>` directly so the first paint is already themed.
 * Settings controls re-render from the store.
 */
export function applyTheme(theme: string, persist = true): void {
	const next: ThemeChoice = THEMES.includes(theme as ThemeChoice) ? (theme as ThemeChoice) : "system";
	setState({ theme: next });
	document.documentElement.dataset.theme = resolvedTheme(next);
	if (persist) writeStorage(STORAGE_KEYS.theme, next);
}

/**
 * Apply and (by default) persist a locale (legacy `applyLocale`, 566-601).
 * Re-translating the page is automatic: components read the locale from the store.
 */
export function applyLocale(locale: string, persist = true): void {
	const next: Locale = locale === "en-US" ? "en-US" : "zh-CN";
	setState({ locale: next });
	document.documentElement.lang = next;
	if (persist) writeStorage(STORAGE_KEYS.locale, next);
}

/** Show or hide the sidebar (legacy `.app.classList.toggle("sidebar-hidden")`, 3383-3388, 3627). */
export function toggleSidebar(): void {
	setUi((ui) => ({ sidebarHidden: !ui.sidebarHidden }));
}

/** Ask before logging out: opens `#logoutDialog`, which calls `confirmLogout`. */
export function logout(): void {
	setUi({ logoutConfirm: { pending: false } });
}

/**
 * Whether an Account or sidebar sign-out has anything it can remove.
 *
 * An environment key is read-only, and a page with neither a stored credential
 * nor an account session has nothing this host can remove.
 */
export function canLogout(login: LoginReport | null): boolean {
	if (!login) return false;
	const session = login.session?.state ?? "missing";
	if (login.source === "environment" && session === "missing") return false;
	return login.configured || session !== "missing";
}

interface StepLogoutResponse {
	readonly removed: boolean;
	readonly accountSessionRemoved: boolean;
	readonly remainingSource: "environment" | null;
	/** A custom models.json model still runs, so the page stays in the app. */
	readonly customModels: boolean;
	readonly login: LoginReport;
}

/** Cancel the log-out dialog; ignored while the request is in flight. */
export function closeLogoutConfirm(): void {
	if (!getState().ui.logoutConfirm?.pending) setUi({ logoutConfirm: null });
}

/**
 * Sign out of Step, not just this page.
 *
 * The Host removes the stored credential, the legacy copies and
 * `step-login.json`, and stops running turns first (a session keeps its model
 * runtime in memory). Reloading then boots the page without a Step credential:
 * with no custom model left, Desktop opens its sign-in gate and plain Web opens
 * it too for this explicit sign-out; with one, the app stays open on it. The
 * launch cookie survives, so no new terminal link is needed. A
 * failure keeps the dialog open, so the user can retry or cancel.
 */
export async function confirmLogout(): Promise<void> {
	if (getState().ui.logoutConfirm?.pending) return;
	setUi({ logoutConfirm: { pending: true } });
	try {
		const result = await api<StepLogoutResponse>("/api/v1/logout", { method: "POST", body: "{}" });
		closeStream();
		setState({ login: result.login, account: null });
		setUi({ logoutConfirm: null, settingsPage: null, settingsEditor: null, settingsDialog: null });
		// Plain Web has no startup gate on a first visit; after an explicit Step
		// sign-out it should ask for a credential instead of opening sessions that
		// cannot call a model. Desktop gates anyway. Custom models (bring your own
		// key) need no Step account, so with one the page stays in the app.
		const keepsCustomModels = !result.login.configured && result.customModels;
		if (!result.login.configured && !result.customModels && typeof sessionStorage !== "undefined") {
			sessionStorage.setItem("stepcode:signInRequired", "1");
		}
		// A partial sign-out must not look complete after the reload. Carry the
		// notice through it; bootstrap shows it once.
		if (typeof sessionStorage !== "undefined") {
			const notice = [
				result.accountSessionRemoved ? undefined : t("logoutWarningAccountSession"),
				result.remainingSource ? t("logoutWarningEnvironment") : undefined,
				keepsCustomModels ? t("logoutContinueCustomModels") : undefined,
			]
				.filter(Boolean)
				.join(" ");
			if (notice) sessionStorage.setItem("stepcode:logoutNotice", notice);
		}
		// Tests and non-browser callers have no location; they inspect the store.
		if (typeof location !== "undefined" && typeof location.reload === "function") location.reload();
	} catch (error) {
		setUi({ logoutConfirm: { pending: false } });
		showError(errorMessage(error));
	}
}

/**
 * Follow the OS theme while the choice is "system" (legacy 3647-3649).
 * Returns the cleanup function.
 */
export function watchSystemTheme(): () => void {
	if (typeof matchMedia !== "function") return () => {};
	const query = matchMedia("(prefers-color-scheme: dark)");
	const onChange = () => {
		if (getState().theme === "system") applyTheme("system", false);
	};
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}
