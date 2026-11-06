import { useState } from "react";
import { useT } from "../../i18n";
import { IconButton, Tooltip } from "../../ui";
import { canRemoveExtension, type ExtensionRemoval, removeExtension } from "./extension-removal";

export function ExtensionRemoveButton({ resource }: { readonly resource: ExtensionRemoval }) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	if (!canRemoveExtension(resource)) return null;
	const label = t(resource.kind === "plugins" ? "settingsUninstall" : "settingsDelete");
	return (
		<Tooltip content={label}>
			<IconButton
				icon="trash"
				iconSize="xs"
				className="settings-icon-action danger"
				aria-label={label}
				data-extension-remove={resource.kind}
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					try {
						await removeExtension(resource, t);
					} finally {
						setBusy(false);
					}
				}}
			/>
		</Tooltip>
	);
}
