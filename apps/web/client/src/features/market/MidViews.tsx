import { useState } from "react";
import { useT } from "../../i18n";
import { cx } from "../../lib/format";
import { activeCwd, startDraft } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import { Icon, IconButton, type IconName, SearchInput } from "../../ui";
import { CRON_DEMO, type DemoCard, MARKET_DEMO } from "./demo";

/** Open one mid-pane view; the two are exclusive. */
export function openMidView(view: "cron" | "market"): void {
	setUi({ midView: view });
}

export function closeMidView(): void {
	setUi({ midView: null });
}

/** `.market-card` (remote 4aea0f8 `cronCard` / `marketCard`). */
function Card({
	card,
	icon,
	offLabel,
	status = false,
}: {
	readonly card: DemoCard;
	/** Without an icon the tile shows the card's initial, so a grid of plugins is not six identical marks. */
	readonly icon?: IconName;
	readonly offLabel: string;
	/** The foot shows a state (a task's enabled/paused), never an action. */
	readonly status?: boolean;
}) {
	const t = useT();
	return (
		<div className="market-card">
			<div className="card-head">
				<span className={cx("card-icon", !icon && "card-monogram")} aria-hidden="true">
					{icon ? <Icon name={icon} /> : card.title.slice(0, 1).toUpperCase()}
				</span>
				<span className="card-title">{card.title}</span>
			</div>
			<div className="card-desc">{card.desc}</div>
			<div className="card-foot">
				<span className="card-meta">{card.meta}</span>
				{status || card.on || card.planned ? (
					<span className={cx("card-action", card.on && "installed", card.planned && "planned")}>
						{card.on ? t("enabled") : card.planned ? t("comingSoon") : offLabel}
					</span>
				) : (
					<button className="card-action" type="button">
						{offLabel}
					</button>
				)}
			</div>
		</div>
	);
}

/** `#cronView`: scheduled tasks covering the conversation (demo data). */
export function CronView() {
	const t = useT();
	const open = useAppStore((state) => state.ui.midView === "cron");
	return (
		<div className={cx("market-view", open && "open")} id="cronView">
			<header className="market-header">
				<strong>{t("cronTasks")}</strong>
				<button
					className="btn-primary"
					id="cronNew"
					type="button"
					onClick={() => {
						closeMidView();
						startDraft(activeCwd());
					}}
				>
					{t("newTask")}
				</button>
				<IconButton
					id="cronClose"
					icon="close"
					title={t("backToConversation")}
					aria-label={t("backToConversation")}
					onClick={closeMidView}
				/>
			</header>
			<div className="market-grid" id="cronGrid">
				{open
					? CRON_DEMO.map((card) => (
							<Card key={card.title} card={card} icon="clock" offLabel={t("paused")} status />
						))
					: null}
			</div>
			<footer className="market-note">{t("cronNote")}</footer>
		</div>
	);
}

/** `#marketView`: searchable plugin cards covering the conversation (demo data). */
export function MarketView() {
	const t = useT();
	const open = useAppStore((state) => state.ui.midView === "market");
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const cards = MARKET_DEMO.filter(
		(card) => !needle || card.title.toLowerCase().includes(needle) || card.desc.toLowerCase().includes(needle),
	);
	return (
		<div className={cx("market-view", open && "open")} id="marketView">
			<header className="market-header">
				<strong>{t("pluginMarket")}</strong>
				<SearchInput
					wrapperClassName="market-search"
					iconSize="sm"
					id="marketSearch"
					placeholder={t("searchPlugins")}
					aria-label={t("searchPlugins")}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<IconButton
					id="marketClose"
					icon="close"
					title={t("backToConversation")}
					aria-label={t("backToConversation")}
					onClick={closeMidView}
				/>
			</header>
			<div className="market-grid" id="marketGrid">
				{open ? cards.map((card) => <Card key={card.title} card={card} offLabel={t("install")} />) : null}
			</div>
			<footer className="market-note">{t("marketNote")}</footer>
		</div>
	);
}
