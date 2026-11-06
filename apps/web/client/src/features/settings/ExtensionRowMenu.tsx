import { useState } from "react";
import { useT } from "../../i18n";
import { IconButton, Menu, MenuItem, Popover, Tooltip } from "../../ui";
import { canRemoveExtension, type ExtensionRemoval, removeExtension } from "./extension-removal";
import { startExtensionTrial } from "./extension-trial";

/**
 * Overflow menu shared by the management rows and the market's installed rows: trial
 * first, removal when the resource allows it. The owner controls `open` so a row can
 * keep its trigger visible while the menu is up; `triggerClassName` / `triggerIconSize`
 * let each surface keep its own trigger chrome.
 */
export function ExtensionRowMenu({
	resource,
	name,
	open,
	onOpenChange,
	triggerClassName,
	triggerIconSize = "xs",
}: {
	readonly resource: ExtensionRemoval;
	readonly name: string;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly triggerClassName: string;
	readonly triggerIconSize?: "xs" | "sm" | "md";
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const removable = canRemoveExtension(resource);
	return (
		<Popover
			open={open}
			onClose={() => onOpenChange(false)}
			placement="bottom-end"
			className="extension-row-menu"
			bare
			content={
				<Menu role="menu" aria-label={`${name} · ${t("extensionMarket.moreActions")}`}>
					<MenuItem
						role="menuitem"
						icon="play"
						disabled={
							resource.kind === "plugins"
								? resource.enabled === false
								: resource.kind === "skills"
									? !resource.skill.enabled
									: !resource.server.enabled
						}
						onClick={() => {
							onOpenChange(false);
							startExtensionTrial(resource);
						}}
					>
						{t("extensionMarket.try")}
					</MenuItem>
					{removable ? (
						<MenuItem
							role="menuitem"
							icon="trash"
							danger
							disabled={busy}
							onClick={async () => {
								setBusy(true);
								try {
									if (await removeExtension(resource, t)) onOpenChange(false);
								} finally {
									setBusy(false);
								}
							}}
						>
							{t("settingsDelete")}
						</MenuItem>
					) : null}
				</Menu>
			}
		>
			<Tooltip content={t("extensionMarket.moreActions")}>
				<IconButton
					className={triggerClassName}
					icon="more"
					iconSize={triggerIconSize}
					data-extension-menu=""
					aria-label={t("extensionMarket.moreActions")}
					onClick={() => onOpenChange(!open)}
				/>
			</Tooltip>
		</Popover>
	);
}
