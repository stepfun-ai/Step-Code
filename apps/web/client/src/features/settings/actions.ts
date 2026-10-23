/**
 * Settings view actions. The view's open page, editor and dialog live in
 * `state.ui` so the shell's Escape chain can close them innermost first; the
 * lists themselves are fetched per page (see `useSettingsResource`).
 */

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { refreshModelCatalog } from "../../state/session";
import { getState, type SettingsEditor, type SettingsPage, setUi } from "../../state/store";

export function openSettings(page: SettingsPage = "general"): void {
	setUi({ settingsPage: page, settingsEditor: null, settingsDialog: null });
}

export function closeSettings(): void {
	setUi({ settingsPage: null, settingsEditor: null, settingsDialog: null });
	// A provider added or removed in the models page must reach the picker this
	// return trip, without starting a new conversation to see it.
	void refreshModelCatalog();
}

export function showSettingsPage(page: SettingsPage): void {
	setUi({ settingsPage: page, settingsEditor: null });
}

export function openSettingsEditor(editor: SettingsEditor): void {
	setUi({ settingsEditor: editor });
}

export function closeSettingsEditor(): void {
	setUi({ settingsEditor: null });
}

export function openSettingsDialog(dialog: "marketplace" | "skillImport"): void {
	setUi({ settingsDialog: dialog });
}

export function closeSettingsDialog(): void {
	setUi({ settingsDialog: null });
}

/**
 * Escape inside the settings view: dialog, then editor, then the view itself.
 * Returns false when the view is closed, so the shell's chain continues.
 */
export function closeTopmostSettingsLayer(): boolean {
	const { ui } = getState();
	if (ui.settingsDialog) closeSettingsDialog();
	else if (ui.settingsEditor) closeSettingsEditor();
	else if (ui.settingsPage) closeSettings();
	else return false;
	return true;
}

export interface SettingsResource<T> {
	readonly data: T | undefined;
	readonly error: string | undefined;
	readonly loading: boolean;
	readonly reload: () => void;
}

/**
 * GET `path` while `active`, and again on `reload()`. A failed reload keeps the
 * last good data on screen next to the error.
 */
export function useSettingsResource<T>(path: string, active: boolean): SettingsResource<T> {
	const [data, setData] = useState<T>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [generation, setGeneration] = useState(0);
	const reload = useCallback(() => setGeneration((value) => value + 1), []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is the reload trigger.
	useEffect(() => {
		if (!active) return;
		let current = true;
		setLoading(true);
		api<T>(path)
			.then((value) => {
				if (!current) return;
				setData(value);
				setError(undefined);
			})
			.catch((caught: unknown) => {
				if (current) setError(errorMessage(caught));
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [path, active, generation]);
	return { data, error, loading, reload };
}
