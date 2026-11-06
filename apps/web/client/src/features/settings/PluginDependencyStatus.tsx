import { useState } from "react";
import { useT } from "../../i18n";
import { copyText } from "../../state/session";
import type { SettingsPluginDependency } from "../../state/types";
import { Button, Icon } from "../../ui";
import { preparePluginCli } from "./plugin-actions";

export function PluginDependencyStatus({
	id,
	dependency,
}: {
	readonly id: string;
	readonly dependency?: SettingsPluginDependency;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	if (!dependency || (!dependency.firstUseConfiguration && dependency.status !== "setup_required")) return null;
	return (
		<div className="plugin-dependency-status" data-plugin-setup={dependency.status}>
			<span>
				{t(dependency.status === "setup_required" ? "pluginDependency.needsSetup" : "pluginDependency.firstUse")}
			</span>
			{dependency.setupCommand ? (
				<Button className="settings-link" onClick={() => void copyText(dependency.setupCommand ?? "", null)}>
					<code>{dependency.setupCommand}</code>
					<Icon name="copy" size="xs" />
				</Button>
			) : null}
			{dependency.status === "setup_required" ? (
				<Button
					className="settings-btn"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						try {
							await preparePluginCli(id, t);
						} finally {
							setBusy(false);
						}
					}}
				>
					{t(busy ? "settingsWorking" : "pluginDependency.prepare")}
				</Button>
			) : null}
		</div>
	);
}
