import { useState } from "react";
import { useT } from "../../i18n";
import { Icon, IconButton, Tooltip } from "../../ui";
import { type ExtensionRemoval, ExtensionRowMenu } from "../settings";
import type { MarketDetailEntry } from "./extension-market-data";

/** Installed entries can be tried or removed; anything else opens the detail to install. */
export function MarketRowActions({
	entry,
	onOpen,
}: {
	readonly entry: MarketDetailEntry;
	readonly onOpen: (id: string) => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const resource: ExtensionRemoval | undefined = entry.installedSkill
		? { kind: "skills", skill: entry.installedSkill }
		: entry.installedPlugin
			? {
					kind: "plugins",
					id: entry.installedPlugin.id,
					name: entry.installedPlugin.name,
					enabled: entry.installedPlugin.enabled,
				}
			: entry.installedConnector
				? { kind: "connectors", server: entry.installedConnector }
				: undefined;

	if (!entry.installed || !resource) {
		return (
			<div className="extension-market-row-actions">
				<Tooltip content={t("extensionMarket.install")}>
					<IconButton
						className="extension-market-add"
						icon="plus"
						aria-label={t("extensionMarket.install")}
						onClick={() => onOpen(entry.id)}
					/>
				</Tooltip>
			</div>
		);
	}

	return (
		<div className="extension-market-row-actions" data-market-installed data-actions-open={open ? "true" : undefined}>
			<span className="extension-market-check" aria-hidden="true">
				<Icon name="check" />
			</span>
			<ExtensionRowMenu
				resource={resource}
				name={entry.name}
				open={open}
				onOpenChange={setOpen}
				triggerClassName="extension-market-more"
				triggerIconSize="md"
			/>
		</div>
	);
}
