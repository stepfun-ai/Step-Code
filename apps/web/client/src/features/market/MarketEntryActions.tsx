import { useT } from "../../i18n";
import { Button, Icon } from "../../ui";
import { ExtensionRemoveButton, PluginInstallButton, SkillInstallButton, startExtensionTrial } from "../settings";
import { openSettingsEditor, showSettingsPage } from "../settings/actions";
import type { MarketDetailEntry } from "./extension-market-data";

/**
 * Detail-page actions: an installed entry can be tried or removed, a catalog entry that is not
 * installed yet only offers the (disabled) install action.
 */
export function MarketEntryActions({
	entry,
	buttonClassName,
}: {
	readonly entry: MarketDetailEntry;
	readonly buttonClassName: string;
}) {
	const t = useT();
	return (
		<div className="extension-market-item-actions">
			{entry.installed ? (
				<Button
					className="extension-market-trial"
					data-market-installed
					data-market-trial
					disabled={
						entry.installedPlugin?.enabled === false ||
						entry.installedSkill?.enabled === false ||
						entry.installedConnector?.enabled === false
					}
					aria-label={entry.installedPlugin?.enabled === false ? t("pluginInstall.disabled") : undefined}
					onClick={() => {
						if (entry.installedSkill) startExtensionTrial({ kind: "skills", skill: entry.installedSkill });
						else if (entry.installedPlugin)
							startExtensionTrial({
								kind: "plugins",
								id: entry.installedPlugin.id,
								name: entry.installedPlugin.name,
								enabled: entry.installedPlugin.enabled,
							});
						else if (entry.installedConnector)
							startExtensionTrial({ kind: "connectors", server: entry.installedConnector });
					}}
				>
					<Icon name="play" />
					{t("extensionMarket.try")}
				</Button>
			) : entry.kind === "plugins" ? (
				<PluginInstallButton catalogId={entry.id} className={buttonClassName} />
			) : entry.kind === "skills" ? (
				<SkillInstallButton catalogId={entry.id} className={buttonClassName} />
			) : (
				<Button
					className={buttonClassName}
					data-market-configure
					onClick={() => {
						showSettingsPage("mcp");
						openSettingsEditor({
							kind: "mcp",
							initialName: entry.catalog?.connection?.serverName,
							initialConfig: entry.catalog?.connection?.configuration,
							evidence: entry.catalog?.connection?.evidence,
						});
					}}
				>
					{t("connectorInstall.configure")}
				</Button>
			)}
			{entry.installedConnector ? (
				<ExtensionRemoveButton resource={{ kind: "connectors", server: entry.installedConnector }} />
			) : null}
			{entry.installedSkill ? (
				<ExtensionRemoveButton resource={{ kind: "skills", skill: entry.installedSkill }} />
			) : null}
			{entry.installedPlugin ? (
				<ExtensionRemoveButton
					resource={{ kind: "plugins", id: entry.installedPlugin.id, name: entry.installedPlugin.name }}
				/>
			) : null}
		</div>
	);
}
