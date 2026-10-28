/**
 * `#settingsView`: a full-window page over the workspace with the settings menu
 * on the left and the selected page on the right. It stays mounted and toggles
 * `hidden`; only the open page is rendered, so each page fetches on open.
 */

import { type ReactNode, useEffect, useRef } from "react";
import { useT } from "../../i18n";
import { cx } from "../../lib/format";
import { type SettingsPage, useAppStore } from "../../state/store";
import { Icon, type IconName } from "../../ui";
import { MigrationPage } from "../migration";
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
			{ page: "account", label: "settingsAccount", icon: "user" },
			{ page: "general", label: "settingsGeneral", icon: "sliders" },
			{ page: "models", label: "settingsModels", icon: "cube" },
			{ page: "appearance", label: "settingsAppearance", icon: "palette" },
			{ page: "migration", label: "migrationTitle", icon: "folder" },
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

function pageContent(page: SettingsPage, migrationAvailable: boolean): ReactNode {
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
			return migrationAvailable ? <MigrationPage /> : <SessionImportPage />;
	}
}

export function SettingsView() {
	const t = useT();
	const page = useAppStore((state) => state.ui.settingsPage);
	const migrationAvailable = useAppStore((state) => state.migrationAvailable);
	const open = page !== null;
	const view = useRef<HTMLDivElement>(null);
	/*
	 * The view covers the workspace, so while it is open the workspace is inert
	 * (no Tab stops, hidden from assistive tech) and focus moves in; closing
	 * hands focus back to whatever opened it, or the footer's settings button.
	 */
	useEffect(() => {
		if (!open) return;
		const workspace = document.querySelector<HTMLElement>(".app");
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		workspace?.setAttribute("inert", "");
		// The open page's menu entry first: focus lands where the reader already is, not on "back".
		const entry =
			view.current?.querySelector<HTMLElement>(".settings-nav-item.active") ??
			view.current?.querySelector<HTMLElement>("#settingsBack");
		entry?.focus({ preventScroll: true });
		return () => {
			workspace?.removeAttribute("inert");
			const target = opener?.isConnected ? opener : document.getElementById("settingsButton");
			target?.focus({ preventScroll: true });
		};
	}, [open]);
	return (
		<div className="settings-view" id="settingsView" hidden={!open} ref={view}>
			<nav className="settings-nav" aria-label={t("settings")}>
				{/* Labelled rows: a tooltip repeating the label would only cover the next row. */}
				<button type="button" className="settings-back" id="settingsBack" onClick={closeSettings}>
					<Icon name="back" />
					<span>{t("settingsBack")}</span>
				</button>
				{MENU.map((group) => (
					<div className="settings-nav-group" key={group.title}>
						<div className="settings-nav-title">{t(group.title)}</div>
						{group.entries.map((entry) => (
							<button
								key={entry.page}
								type="button"
								className={cx("settings-nav-item", page === entry.page && "active")}
								data-settings-page={entry.page}
								aria-current={page === entry.page ? "page" : undefined}
								onClick={() => showSettingsPage(entry.page)}
							>
								<Icon name={entry.icon} />
								<span>{t(entry.label)}</span>
							</button>
						))}
					</div>
				))}
			</nav>
			<main className="settings-main">
				{page ? (
					<div className="settings-content" key={page} data-page={page}>
						{pageContent(page, migrationAvailable)}
					</div>
				) : null}
			</main>
		</div>
	);
}
