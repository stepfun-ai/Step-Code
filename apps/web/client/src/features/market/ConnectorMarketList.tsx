import { useRef, useState } from "react";
import { useT } from "../../i18n";
import type { SettingsMcpServer } from "../../state/types";
import { Button, EmptyState, Icon, Tooltip } from "../../ui";
import { ExtensionRowMenu } from "../settings";
import { connectorSource, connectorStatus, filterConnectors } from "./connector-market-data";
import { MarketOriginBadge } from "./MarketOriginBadge";

function ConnectorRow({
	server,
	onOpen,
	onManage,
}: {
	readonly server: SettingsMcpServer;
	readonly onOpen: (name: string) => void;
	readonly onManage: () => void;
}) {
	const t = useT();
	const description = useRef<HTMLSpanElement>(null);
	const [truncated, setTruncated] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const summary = `${connectorSource(t, server)} · ${server.transport === "stdio" ? "stdio" : "HTTP"} · ${connectorStatus(t, server)}`;
	return (
		<div className="extension-market-row" data-market-connector={server.name}>
			<Button
				className="extension-market-open"
				data-market-entry={`connector:${server.name}`}
				aria-label={t("extensionDetail.open", { name: server.name })}
				onClick={() => onOpen(server.name)}
				onMouseEnter={() => {
					const element = description.current;
					setTruncated(Boolean(element && element.scrollWidth > element.clientWidth));
				}}
			>
				<span className="extension-market-placeholder" aria-hidden="true">
					<Icon name={server.transport === "stdio" ? "terminal" : "globe"} />
				</span>
				<span className="extension-market-copy">
					<span className="extension-market-item-title">
						<span className="extension-market-name">{server.name}</span>
						<MarketOriginBadge selfMade={server.origin === "stepcode"} />
					</span>
					<Tooltip content={truncated ? summary : null}>
						<span ref={description} className="extension-market-description">
							{summary}
						</span>
					</Tooltip>
				</span>
			</Button>
			<div className="extension-market-item-actions">
				<Button className="extension-market-manage" onClick={onManage}>
					{t("extensionMarket.manage")}
				</Button>
				<ExtensionRowMenu
					resource={{ kind: "connectors", server }}
					name={server.name}
					open={menuOpen}
					onOpenChange={setMenuOpen}
					triggerClassName="extension-market-more"
				/>
			</div>
		</div>
	);
}

export function ConnectorMarketList({
	servers,
	query,
	loading,
	error,
	onOpen,
	onManage,
	hideEmpty = false,
}: {
	readonly servers: readonly SettingsMcpServer[];
	readonly hideEmpty?: boolean;
	readonly query: string;
	readonly loading: boolean;
	readonly error?: string;
	readonly onOpen: (name: string) => void;
	readonly onManage: () => void;
}) {
	const t = useT();
	const visible = filterConnectors(servers, query);
	return (
		<div className="extension-market-section">
			{error ? (
				<p role="alert" className="extension-market-upload-status">
					{t("settingsMcpLoadFailed")}
				</p>
			) : null}
			{loading ? <output>{t("settingsLoading")}</output> : null}
			<div className="extension-market-grid">
				{visible.map((server) => (
					<ConnectorRow key={server.name} server={server} onOpen={onOpen} onManage={onManage} />
				))}
			</div>
			{!hideEmpty && !loading && !error && visible.length === 0 ? (
				<EmptyState>{t(servers.length ? "extensionMarket.empty" : "extensionMarket.connectorsEmpty")}</EmptyState>
			) : null}
		</div>
	);
}
