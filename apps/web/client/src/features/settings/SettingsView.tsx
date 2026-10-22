/**
 * `#settingsView`: a full-window page over the workspace with the settings menu
 * on the left and the selected page on the right. It stays mounted and toggles
 * `hidden`; only the open page is rendered, so each page fetches on open.
 */

import type { ReactNode } from "react";
import { useT } from "../../i18n";
import { cx } from "../../lib/format";
import { type SettingsPage, useAppStore } from "../../state/store";
import { Icon, type IconName, Tooltip } from "../../ui";
import { AccountPage } from "./AccountPage";
import { AppearancePage } from "./AppearancePage";
import { closeSettings, showSettingsPage } from "./actions";
import { GeneralPage } from "./GeneralPage";
import { McpPage } from "./McpPage";
import { ModelsPage } from "./ModelsPage";
import { PluginsPage } from "./PluginsPage";
import { SessionImportPage } from "./SessionImportPage";
import { SkillsPage } from "./SkillsPage";

interface MenuEntry {
	readonly page: SettingsPage;
	readonly label: string;
	readonly icon: IconName;
}

const MENU: ReadonlyArray<{ readonly title: string; readonly entries: readonly MenuEntry[] }> = [
	{
		title: "settingsGroupBasics",
		entries: [
			{ page: "account", label: "settingsAccount", icon: "stepPlatform" },
			{ page: "general", label: "settingsGeneral", icon: "sliders" },
			{ page: "models", label: "settingsModels", icon: "cube" },
			{ page: "appearance", label: "settingsAppearance", icon: "palette" },
			{ page: "migration", label: "importTitle", icon: "folder" },
		],
	},
	{
		title: "settingsGroupAgent",
		entries: [
			{ page: "plugins", label: "settingsPlugins", icon: "puzzle" },
			{ page: "mcp", label: "settingsMcp", icon: "mcp" },
			{ page: "skills", label: "settingsSkills", icon: "wand" },
		],
	},
];

function pageContent(page: SettingsPage): ReactNode {
	switch (page) {
		case "general":
			return <GeneralPage />;
		case "account":
			return <AccountPage />;
		case "appearance":
			return <AppearancePage />;
		case "models":
			return <ModelsPage />;
		case "plugins":
			return <PluginsPage />;
		case "mcp":
			return <McpPage />;
		case "skills":
			return <SkillsPage />;
		case "migration":
			return <SessionImportPage />;
	}
}

export function SettingsView() {
	const t = useT();
	const page = useAppStore((state) => state.ui.settingsPage);
	return (
		<div className="settings-view" id="settingsView" hidden={page === null}>
			<nav className="settings-nav" aria-label={t("settings")}>
				<Tooltip content={t("settingsBack")}>
					<button type="button" className="settings-back" id="settingsBack" onClick={closeSettings}>
						<Icon name="back" size="sm" />
						<span>{t("settingsBack")}</span>
					</button>
				</Tooltip>
				{MENU.map((group) => (
					<div className="settings-nav-group" key={group.title}>
						<div className="settings-nav-title">{t(group.title)}</div>
						{group.entries.map((entry) => (
							<Tooltip key={entry.page} content={t(entry.label)}>
								<button
									type="button"
									className={cx("settings-nav-item", page === entry.page && "active")}
									data-settings-page={entry.page}
									aria-current={page === entry.page ? "page" : undefined}
									onClick={() => showSettingsPage(entry.page)}
								>
									<Icon name={entry.icon} size="sm" />
									<span>{t(entry.label)}</span>
								</button>
							</Tooltip>
						))}
					</div>
				))}
				<p className="settings-nav-note">{t("settingsMoreSoon")}</p>
			</nav>
			<main className="settings-main">
				{page ? (
					<div className="settings-content" key={page} data-page={page}>
						{pageContent(page)}
					</div>
				) : null}
			</main>
		</div>
	);
}
