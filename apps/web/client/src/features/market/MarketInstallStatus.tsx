import { useT } from "../../i18n";
import { Button, Tooltip } from "../../ui";

/**
 * Install action for a market entry: the local catalog carries no installation flow yet, so the
 * button stays disabled and explains why on hover. The tooltip rides on a wrapper span because a
 * disabled button fires no pointer events of its own.
 */
export function MarketInstallStatus({
	catalog,
	buttonClassName,
}: {
	readonly catalog?: boolean;
	readonly buttonClassName: string;
}) {
	const t = useT();
	return (
		<Tooltip content={t(catalog ? "extensionMarket.catalogInstallPending" : "extensionDetail.installPending")}>
			<span className="extension-market-install-host">
				<Button className={buttonClassName} disabled data-market-not-installed>
					{t("extensionMarket.install")}
				</Button>
			</span>
		</Tooltip>
	);
}
