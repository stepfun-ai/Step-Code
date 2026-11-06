import { useState } from "react";
import { useT } from "../../i18n";
import { Button } from "../../ui";
import { installCatalogSkill } from "./skill-actions";
export function SkillInstallButton({
	catalogId,
	className,
}: {
	readonly catalogId: string;
	readonly className: string;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	return (
		<Button
			className={className}
			disabled={busy}
			data-market-not-installed
			onClick={async () => {
				setBusy(true);
				try {
					await installCatalogSkill(catalogId, t);
				} finally {
					setBusy(false);
				}
			}}
		>
			{t(busy ? "settingsWorking" : "extensionMarket.install")}
		</Button>
	);
}
