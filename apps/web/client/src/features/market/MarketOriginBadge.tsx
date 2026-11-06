import { useT } from "../../i18n";
import { Tooltip } from "../../ui";

/** StepFun's own extensions carry the official mark, the way official marketplaces label theirs. */
export function MarketOriginBadge({ selfMade }: { readonly selfMade: boolean }) {
	const t = useT();
	if (!selfMade) return null;
	return (
		<Tooltip content={t("extensionMarket.officialHint")}>
			<span className="extension-market-origin" data-market-official>
				{t("extensionMarket.official")}
			</span>
		</Tooltip>
	);
}
