import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import type { SettingsMcpServer, SettingsPluginCatalog, SettingsSkill } from "../../state/types";
import { Button, EmptyState, Icon, IconButton, SearchInput, SegmentedControl, Tooltip } from "../../ui";
import { openSettingsEditor, showSettingsPage, useSettingsResource } from "../settings/actions";
import { ConnectorMarketDetail } from "./ConnectorMarketDetail";
import { ConnectorMarketList } from "./ConnectorMarketList";
import { ExtensionMarketAdd } from "./ExtensionMarketAdd";
import { ExtensionMarketDetail } from "./ExtensionMarketDetail";
import {
	applyConnectorInstallations,
	applyPluginInstallations,
	applySkillInstallations,
	filterEntries,
	MARKET_CATEGORIES,
	type MarketCategory,
	type MarketDetailEntry,
	type MarketTab,
	marketEntries,
} from "./extension-market-data";
import { MarketOriginBadge } from "./MarketOriginBadge";
import { MarketRowActions } from "./MarketRowActions";

function MarketRow({ entry, onOpen }: { readonly entry: MarketDetailEntry; readonly onOpen: (id: string) => void }) {
	const t = useT();
	const [truncated, setTruncated] = useState(false);
	const description = useRef<HTMLSpanElement>(null);
	return (
		<div className="extension-market-row">
			<Button
				className="extension-market-open"
				data-market-entry={entry.id}
				aria-label={t(entry.selfMade ? "extensionDetail.openSelfMade" : "extensionDetail.open", {
					name: entry.name,
				})}
				onClick={() => onOpen(entry.id)}
				onMouseEnter={() => {
					const text = description.current;
					setTruncated(Boolean(text && text.scrollWidth > text.clientWidth));
				}}
			>
				<span className="extension-market-placeholder" aria-hidden="true">
					{entry.logo ? <img src={entry.logo} alt="" /> : <span />}
				</span>
				<span className="extension-market-copy">
					<span className="extension-market-item-title">
						<span className="extension-market-name">{entry.name}</span>
						<MarketOriginBadge selfMade={entry.selfMade} />
					</span>
					<Tooltip content={truncated ? entry.description : null}>
						<span className="extension-market-description" ref={description}>
							{entry.description}
						</span>
					</Tooltip>
				</span>
			</Button>
			<MarketRowActions entry={entry} onOpen={onOpen} />
		</div>
	);
}

/** Sample documents and the live configured connector registry; browsing never installs resources. */
export function ExtensionMarketPage() {
	const t = useT();
	const [kind, setKind] = useState<MarketTab>("plugins");
	const settingsPage = useAppStore((state) => state.ui.settingsPage);
	const pluginState = useSettingsResource<SettingsPluginCatalog>(
		"/api/v1/settings/plugins",
		kind === "plugins" && !settingsPage,
	);
	const installationState = useSettingsResource<{ skills: SettingsSkill[] }>(
		"/api/v1/settings/skills",
		kind === "skills" && !settingsPage,
	);
	const connectorState = useSettingsResource<{ servers: SettingsMcpServer[] }>(
		"/api/v1/settings/mcp",
		kind === "connectors" && !settingsPage,
	);
	const servers = Array.isArray(connectorState.data?.servers) ? connectorState.data.servers : [];
	const [connectorName, setConnectorName] = useState<string | null>(null);
	const [category, setCategory] = useState<MarketCategory>("all");
	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const returnEntry = useRef<string | null>(null);
	useEffect(() => {
		if (
			connectorName &&
			connectorState.data &&
			!connectorState.data.servers?.some((server) => server.name === connectorName)
		)
			setConnectorName(null);
	}, [connectorName, connectorState.data]);
	useEffect(() => {
		if (!selectedId && !connectorName && returnEntry.current)
			document.querySelector<HTMLButtonElement>(`[data-market-entry="${CSS.escape(returnEntry.current)}"]`)?.focus();
	}, [selectedId, connectorName]);
	const entries = applyConnectorInstallations(
		applyPluginInstallations(
			applySkillInstallations(
				marketEntries(kind),
				Array.isArray(installationState.data?.skills) ? installationState.data.skills : [],
			),
			pluginState.data,
		),
		servers,
	);
	const selected = entries.find((entry) => entry.id === selectedId);
	const visible = filterEntries(entries, category, query);
	const selectedConnector =
		kind === "connectors" ? servers.find((server) => server.name === connectorName) : undefined;
	if (selectedConnector)
		return (
			<ConnectorMarketDetail
				server={selectedConnector}
				onBack={() => setConnectorName(null)}
				onManage={() => showSettingsPage("mcp")}
			/>
		);
	if (selected) return <ExtensionMarketDetail entry={selected} onBack={() => setSelectedId(null)} />;
	return (
		<section className="extension-market" aria-label={t("extensionMarket.title")}>
			<header className="extension-market-toolbar">
				<SegmentedControl
					className="extension-market-kinds"
					aria-label={t("extensionMarket.types")}
					items={(["plugins", "skills", "connectors"] as const).map((value) => ({
						value,
						label: t(`extensionMarket.${value}`),
						attrs: { "data-market-kind": value },
					}))}
					value={kind}
					onChange={(value) => {
						setKind(value);
						setConnectorName(null);
						setSelectedId(null);
					}}
				/>
				<div className="extension-market-actions">
					<Tooltip content={t("extensionMarket.refresh")}>
						<IconButton
							icon="refresh"
							aria-label={t("extensionMarket.refresh")}
							disabled={
								kind === "plugins"
									? pluginState.loading
									: kind === "skills"
										? installationState.loading
										: connectorState.loading
							}
							onClick={
								kind === "plugins"
									? pluginState.reload
									: kind === "connectors"
										? connectorState.reload
										: installationState.reload
							}
						/>
					</Tooltip>
					<Button
						className="extension-market-manage"
						onClick={() => showSettingsPage(kind === "connectors" ? "mcp" : kind)}
					>
						<Icon name="sliders" />
						{t("extensionMarket.manage")}
					</Button>
					{kind === "connectors" ? (
						<Button
							id="extensionMarketNew"
							className="extension-market-create"
							onClick={() => {
								showSettingsPage("mcp");
								openSettingsEditor({ kind: "mcp" });
							}}
						>
							<Icon name="plus" />
							{t("settingsNew")}
						</Button>
					) : (
						<ExtensionMarketAdd key={kind} kind={kind} />
					)}
				</div>
			</header>
			<div className="extension-market-body">
				{kind === "skills" && installationState.error ? (
					<p className="extension-market-upload-status" role="alert">
						{t("extensionMarket.statusUnavailable")}
					</p>
				) : null}
				<SearchInput
					id="marketSearch"
					wrapperClassName="extension-market-search"
					placeholder={t("extensionMarket.search")}
					aria-label={t("extensionMarket.search")}
					defaultValue={query}
					onInputCapture={(event) => setQuery(event.currentTarget.value)}
				/>
				{kind !== "connectors" ? (
					<SegmentedControl
						bare
						className="extension-market-categories"
						itemClassName="extension-market-category"
						aria-label={t("extensionMarket.categories")}
						items={MARKET_CATEGORIES.map((value) => ({
							value,
							label: t(`extensionMarket.${value}`),
							attrs: { "data-market-category": value },
						}))}
						value={category}
						onChange={setCategory}
					/>
				) : null}
				<div className="extension-market-section">
					<div className="extension-market-grid">
						{visible.map((entry) => (
							<MarketRow
								key={entry.id}
								entry={entry}
								onOpen={(id) => {
									returnEntry.current = id;
									setSelectedId(id);
								}}
							/>
						))}
					</div>
					{visible.length === 0 ? <EmptyState>{t("extensionMarket.empty")}</EmptyState> : null}
				</div>
				{kind === "connectors" ? (
					<ConnectorMarketList
						hideEmpty={entries.length > 0}
						servers={servers.filter(
							(server) => !entries.some((entry) => entry.installedConnector?.name === server.name),
						)}
						query={query}
						loading={connectorState.loading}
						error={connectorState.error}
						onOpen={(name) => {
							returnEntry.current = `connector:${name}`;
							setConnectorName(name);
						}}
						onManage={() => showSettingsPage("mcp")}
					/>
				) : null}
			</div>
		</section>
	);
}
