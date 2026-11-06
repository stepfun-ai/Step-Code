import { useEffect, useRef } from "react";
import { useT } from "../../i18n";
import type { SettingsMcpServer } from "../../state/types";
import { Button, Icon } from "../../ui";
import { ExtensionRemoveButton, startExtensionTrial } from "../settings";
import { connectorAuth, connectorSource, connectorStatus, sanitizedServiceUrl } from "./connector-market-data";

export function ConnectorMarketDetail({
	server,
	onBack,
	onManage,
}: {
	readonly server: SettingsMcpServer;
	readonly onBack: () => void;
	readonly onManage: () => void;
}) {
	const t = useT();
	const back = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		back.current?.focus();
	}, []);
	const auth = connectorAuth(server);
	const address = sanitizedServiceUrl(server.config?.url);
	return (
		<section className="extension-detail" data-connector-detail={server.name} aria-label={server.name}>
			<nav className="extension-detail-back" aria-label={t("extensionDetail.navigation")}>
				<Button ref={back} onClick={onBack}>
					<Icon name="back" />
					{t("extensionDetail.back")}
				</Button>
				<Icon name="chevronRight" size="sm" />
				<span>{t("extensionMarket.connectors")}</span>
			</nav>
			<header className="extension-detail-header">
				<span className="extension-detail-icon" aria-hidden="true">
					<Icon name={server.transport === "stdio" ? "terminal" : "globe"} size="lg" />
				</span>
				<div className="extension-detail-heading">
					<div className="extension-detail-name-row">
						<h1>{server.name}</h1>
						<span className="extension-detail-version">{server.transport === "stdio" ? "stdio" : "HTTP"}</span>
					</div>
					<p className="extension-detail-submeta">
						<span>{connectorSource(t, server)}</span>
						<span>{connectorStatus(t, server)}</span>
					</p>
				</div>
				<div className="extension-market-item-actions">
					<Button className="extension-market-manage" onClick={onManage}>
						{t("extensionMarket.manage")}
					</Button>
					<Button
						className="extension-market-trial"
						disabled={!server.enabled}
						data-market-trial
						onClick={() => startExtensionTrial({ kind: "connectors", server })}
					>
						<Icon name="play" />
						{t("extensionMarket.try")}
					</Button>
					<ExtensionRemoveButton resource={{ kind: "connectors", server }} />
				</div>
			</header>
			<section className="extension-detail-component" data-component-section="mcp">
				<h2>
					{t("extensionDetail.connectorService")}
					<span className="extension-detail-count">1</span>
				</h2>
				<div className="extension-detail-connector-summary">
					<strong>{server.name}</strong>
					<span className="extension-detail-badge">{server.transport === "stdio" ? "stdio" : "HTTP"}</span>
					<dl className="extension-detail-facts">
						<div>
							<dt>{t("extensionMarket.connectorTransport")}</dt>
							<dd>{server.transport === "stdio" ? "stdio" : "HTTP"}</dd>
						</div>
						<div>
							<dt>{t("extensionDetail.authMethod")}</dt>
							<dd>
								{auth === "oauth"
									? t("extensionDetail.authOauth")
									: auth === "bearer"
										? t("extensionDetail.authBearer")
										: auth === "header"
											? t("extensionDetail.authHeader")
											: t("extensionDetail.unknown")}
							</dd>
						</div>
						<div className="extension-detail-fact-wide">
							<dt>{t("extensionDetail.serviceAddress")}</dt>
							<dd>
								{address
									? address
									: server.transport === "stdio"
										? t("extensionDetail.localStdio")
										: t("extensionDetail.unknown")}
							</dd>
						</div>
					</dl>
					<p className="extension-detail-item-note">
						{connectorStatus(t, server)}
						{server.toolCount === undefined
							? ""
							: ` · ${t("extensionMarket.connectorTools")}: ${server.toolCount}`}
					</p>
					{address ? <p className="extension-detail-item-note">{t("extensionDetail.addressRedacted")}</p> : null}
				</div>
			</section>
			<section className="extension-detail-docs">
				<div className="extension-detail-docs-head">
					<h2>{t("extensionDetail.connectorDocs")}</h2>
				</div>
				<p className="extension-detail-file-note">{t("extensionMarket.connectorMetadataOnly")}</p>
				{server.status === "failed" && server.enabled ? <p>{t("settingsMcpSafeFailure")}</p> : null}
			</section>
		</section>
	);
}
