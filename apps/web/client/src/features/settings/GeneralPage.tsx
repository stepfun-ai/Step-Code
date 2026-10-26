/**
 * General: interface language. Account actions live on the Account page.
 */

import { useT } from "../../i18n";
import type { Locale } from "../../i18n/messages";
import { cx } from "../../lib/format";
import { useAppStore } from "../../state/store";
import { applyLocale } from "../shell/actions";
import { PageHeader, SettingRow, SettingsCard } from "./parts";

/** Language names are shown in their own language, never translated. */
const LANGUAGE_CHOICES: ReadonlyArray<{ readonly value: Locale; readonly label: string }> = [
	{ value: "zh-CN", label: "简体中文" },
	{ value: "en-US", label: "English" },
];

/** `2026-10-26T09:02:22.531Z` → `2026-10-26 17:02`, in the reader's own time zone. */
function buildStamp(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const pad = (part: number) => String(part).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function GeneralPage() {
	const t = useT();
	const locale = useAppStore((state) => state.locale);
	const build = useAppStore((state) => state.build);
	return (
		<>
			<PageHeader title={t("settingsGeneral")} description={t("settingsGeneralDesc")} />
			<SettingsCard>
				<SettingRow
					title={t("settingsLanguage")}
					description={t("settingsLanguageDesc")}
					control={
						<div className="settings-choice-group">
							{LANGUAGE_CHOICES.map((choice) => (
								<button
									key={choice.value}
									type="button"
									aria-pressed={locale === choice.value}
									className={cx("settings-choice", locale === choice.value && "active")}
									data-language-choice={choice.value}
									onClick={() => applyLocale(choice.value)}
								>
									{choice.label}
								</button>
							))}
						</div>
					}
				/>
			</SettingsCard>
			{/*
			 * Which build this window is running. An installed copy and a source
			 * checkout look identical otherwise, and "did the update take?" was
			 * otherwise only answerable from a terminal.
			 */}
			{build.version || build.madeAt ? (
				<SettingsCard>
					<SettingRow
						title={t("settingsBuild")}
						description={build.madeAt ? t("settingsBuildMadeAt") : t("settingsBuildDev")}
						control={
							<span className="settings-build" id="settingsBuild">
								{build.version ? <span className="settings-build-version">v{build.version}</span> : null}
								{build.madeAt ? <span className="settings-build-time">{buildStamp(build.madeAt)}</span> : null}
							</span>
						}
					/>
				</SettingsCard>
			) : null}
		</>
	);
}
