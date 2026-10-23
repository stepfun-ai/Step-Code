/**
 * Appearance: the interface theme, picked from four preview tiles. The themes
 * are named for their material: Porcelain (light), Nocturne (dark) and Violet
 * (the periwinkle light variant); the stored choice values stay
 * "light" / "dark" / "violet".
 */

import { useT } from "../../i18n";
import { cx } from "../../lib/format";
import { type ThemeChoice, useAppStore } from "../../state/store";
import { Icon } from "../../ui";
import { applyTheme } from "../shell/actions";
import { PageHeader, SectionHeader, SettingsCard } from "./parts";

const THEME_CHOICES: ReadonlyArray<{ readonly value: ThemeChoice; readonly label: string; readonly hint: string }> = [
	{ value: "system", label: "themeSystem", hint: "settingsThemeSystemNamedHint" },
	{ value: "light", label: "themePorcelain", hint: "settingsThemePorcelainHint" },
	{ value: "dark", label: "themeNocturne", hint: "settingsThemeNocturneHint" },
	{ value: "violet", label: "themeViolet", hint: "settingsThemeVioletHint" },
];

/** A miniature window in the tile's own palette, so each choice previews itself in either theme. */
function ThemePreview({ variant }: { readonly variant: ThemeChoice }) {
	return (
		<span className={cx("theme-preview", variant)} aria-hidden="true">
			<span className="theme-preview-half light">
				<i className="bar" />
				<i className="line" />
				<i className="line short" />
			</span>
			<span className="theme-preview-half dark">
				<i className="bar" />
				<i className="line" />
				<i className="line short" />
			</span>
			<span className="theme-preview-half violet">
				<i className="bar" />
				<i className="line" />
				<i className="line short" />
			</span>
		</span>
	);
}

export function AppearancePage() {
	const t = useT();
	const theme = useAppStore((state) => state.theme);
	return (
		<>
			<PageHeader title={t("settingsAppearance")} description={t("settingsAppearanceDesc")} />
			<SectionHeader title={t("settingsTheme")} hint={t("settingsThemeDesc")} />
			<SettingsCard className="settings-theme-card">
				<div className="theme-choices">
					{THEME_CHOICES.map((choice) => {
						const active = theme === choice.value;
						return (
							<button
								key={choice.value}
								type="button"
								aria-pressed={active}
								className={cx("theme-choice", active && "active")}
								data-theme-choice={choice.value}
								onClick={() => applyTheme(choice.value)}
							>
								<ThemePreview variant={choice.value} />
								<span className="theme-choice-label">
									<span>
										<strong>{t(choice.label)}</strong>
										<small>{t(choice.hint)}</small>
									</span>
									<span className="theme-choice-check">{active ? <Icon name="check" size="xs" /> : null}</span>
								</span>
							</button>
						);
					})}
				</div>
			</SettingsCard>
		</>
	);
}
