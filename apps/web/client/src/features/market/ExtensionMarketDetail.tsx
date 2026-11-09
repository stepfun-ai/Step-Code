import { type ReactNode, useEffect, useRef, useState } from "react";
import { useMarkdownLabels, useT } from "../../i18n";
import { copyText } from "../../state/session";
import { Button, EmptyState, Icon, MarkdownView, Tooltip } from "../../ui";
import { PluginDependencyStatus } from "../settings";
import type { CatalogItem, MarketDetailEntry } from "./extension-market-data";
import { MarketEntryActions } from "./MarketEntryActions";
import { MarketOriginBadge } from "./MarketOriginBadge";

const CATEGORY_KEYS: Readonly<
	Record<
		string,
		| "extensionMarket.all"
		| "extensionMarket.office"
		| "extensionMarket.creative"
		| "extensionMarket.code"
		| "extensionMarket.other"
	>
> = {
	all: "extensionMarket.all",
	office: "extensionMarket.office",
	creative: "extensionMarket.creative",
	code: "extensionMarket.code",
	other: "extensionMarket.other",
};

function ItemRow({ item, transport }: { readonly item: CatalogItem; readonly transport?: boolean }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	return (
		<li>
			<span className="extension-detail-item-icon" aria-hidden="true">
				<Icon name={transport ? (item.transport === "http" ? "globe" : "terminal") : "wand"} />
			</span>
			<div className="extension-detail-item-copy">
				<div className="extension-detail-item-title">
					<strong>{item.name}</strong>
					{transport ? (
						<span className="extension-detail-badge">{item.transport === "http" ? "HTTP" : "stdio"}</span>
					) : null}
				</div>
				{item.description ? (
					<button
						type="button"
						className="extension-detail-item-desc"
						data-expanded={open ? "true" : undefined}
						aria-expanded={open}
						onClick={() => setOpen((value) => !value)}
					>
						{item.description}
					</button>
				) : null}
				{transport ? <p className="extension-detail-item-note">{t("extensionDetail.declared")}</p> : null}
			</div>
		</li>
	);
}

function ItemList({ items, transport }: { readonly items: readonly CatalogItem[]; readonly transport?: boolean }) {
	return (
		<ul className="extension-detail-items">
			{items.map((item) => (
				<ItemRow key={item.name} item={item} transport={transport} />
			))}
		</ul>
	);
}

const COLLAPSED_ITEMS = 6;

function ComponentSection({
	title,
	items,
	transport,
	count,
	children,
}: {
	readonly title: string;
	readonly items?: readonly CatalogItem[];
	readonly transport?: boolean;
	readonly count?: number;
	readonly children?: ReactNode;
}) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const total = items?.length ?? 0;
	const collapsible = total > COLLAPSED_ITEMS;
	const visible = items ? (expanded ? items : items.slice(0, COLLAPSED_ITEMS)) : [];
	return (
		<section className="extension-detail-component" data-component-section={title}>
			<h2>
				{title}
				<span className="extension-detail-count">{count ?? total}</span>
				{collapsible ? (
					<Button
						className="extension-detail-expand"
						aria-expanded={expanded}
						onClick={() => setExpanded((value) => !value)}
					>
						{t(expanded ? "extensionDetail.collapseAll" : "extensionDetail.expandAll")}
						<span className="extension-detail-chevron" data-open={expanded ? "true" : undefined}>
							<Icon name="chevronDown" size="sm" />
						</span>
					</Button>
				) : null}
			</h2>
			{items?.length ? <ItemList items={visible} transport={transport} /> : children}
		</section>
	);
}

interface Props {
	readonly entry: MarketDetailEntry;
	readonly onBack: () => void;
}

export function ExtensionMarketDetail({ entry, onBack }: Props) {
	const t = useT();
	const labels = useMarkdownLabels();
	const back = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		back.current?.focus();
	}, []);
	const document = entry.document;
	const catalog = entry.catalog;
	const connection = catalog?.connection;
	const filename =
		document?.filename ?? (entry.kind === "plugins" ? "README" : entry.kind === "skills" ? "SKILL.md" : "README");
	const author = document?.publisher?.trim() || catalog?.package.split("__")[0];
	const authorLabel = author ? (/\s/.test(author) ? author : `@${author}`) : t("extensionDetail.unknown");
	const skills = catalog?.items.skills ?? [];
	const connectors = catalog?.items.connectors ?? [];
	const commands = catalog?.items.commands ?? [];
	const docsTitle =
		entry.kind === "plugins"
			? t("extensionDetail.docsTab")
			: entry.kind === "skills"
				? t("extensionDetail.skillDocs")
				: t("extensionDetail.connectorDocs");
	return (
		<section className="extension-detail" data-detail-example={entry.example} aria-label={entry.name}>
			<nav className="extension-detail-back" aria-label={t("extensionDetail.navigation")}>
				<Button ref={back} onClick={onBack}>
					<Icon name="back" />
					{t("extensionDetail.back")}
				</Button>
				<Icon name="chevronRight" size="sm" />
				<span>{t(`extensionMarket.${entry.kind}`)}</span>
			</nav>
			<header className="extension-detail-header">
				<span className="extension-detail-icon" aria-hidden="true">
					{entry.logo ? (
						<img src={entry.logo} alt="" />
					) : (
						<Icon
							name={
								entry.kind === "connectors"
									? connection?.transport === "stdio"
										? "terminal"
										: "globe"
									: entry.kind === "skills"
										? "wand"
										: "sliders"
							}
							size="lg"
						/>
					)}
				</span>
				<div className="extension-detail-heading">
					<div className="extension-detail-name-row">
						<h1>{entry.name}</h1>
						<MarketOriginBadge selfMade={entry.selfMade} />
						{document?.version ? <span className="extension-detail-version">v{document.version}</span> : null}
					</div>
					<p className="extension-detail-byline">
						<span>{authorLabel}</span>
						<Tooltip content={entry.downloads === undefined ? t("extensionDetail.downloadsUnavailable") : null}>
							<span className="extension-detail-downloads">
								<Icon name="download" size="xs" />
								{entry.downloads ?? "—"} {t("extensionDetail.installs")}
							</span>
						</Tooltip>
						{entry.categories[0] ? <span>{t(CATEGORY_KEYS[entry.categories[0]])}</span> : null}
					</p>
					<p className="extension-detail-description">{entry.description}</p>
				</div>
				<MarketEntryActions entry={entry} buttonClassName="extension-market-create" />
			</header>

			{entry.installedPlugin ? (
				<PluginDependencyStatus id={entry.installedPlugin.id} dependency={entry.installedPlugin.dependency} />
			) : null}
			{skills.length > 0 ? <ComponentSection title={t("extensionMarket.skills")} items={skills} /> : null}
			{connectors.length > 0 ? (
				<ComponentSection title={t("extensionMarket.connectors")} items={connectors} transport />
			) : null}
			{commands.length > 0 ? <ComponentSection title={t("extensionDetail.commands")} items={commands} /> : null}
			{entry.kind === "connectors" ? (
				<ComponentSection title={t("extensionDetail.connectorService")} count={1}>
					<div className="extension-detail-connector-summary">
						<strong>{entry.name}</strong>
						<span className="extension-detail-badge">{t("extensionDetail.originalPackage")}</span>
						<dl className="extension-detail-facts">
							<div>
								<dt>{t("extensionMarket.connectorTransport")}</dt>
								<dd>
									{connection?.transport === "http"
										? "HTTP"
										: connection?.transport === "stdio"
											? connection.url
												? "stdio / HTTP"
												: "stdio"
											: t("extensionDetail.unknown")}
								</dd>
							</div>
							<div>
								<dt>{t("extensionDetail.authMethod")}</dt>
								<dd>
									{connection?.auth === "oauth"
										? t("extensionDetail.authOauth")
										: connection?.auth === "bearer"
											? t("extensionDetail.authBearer")
											: connection?.auth === "header"
												? t("extensionDetail.authHeader")
												: connection?.auth === "env"
													? t("extensionDetail.authEnv")
													: connection?.auth === "apiKey"
														? t("extensionDetail.authApiKey")
														: t("extensionDetail.unknown")}
								</dd>
							</div>
							<div className="extension-detail-fact-wide">
								<dt>{t("extensionDetail.serviceAddress")}</dt>
								<dd>
									{connection?.url
										? connection.url
										: connection?.transport === "stdio"
											? t("extensionDetail.localStdio")
											: t("extensionDetail.unknown")}
								</dd>
							</div>
						</dl>
						<p className="extension-detail-item-note">
							{connection?.source === "readme"
								? t("extensionDetail.connectionFromReadme")
								: connection?.source === "manifest"
									? t("extensionDetail.connectionDeclared")
									: t("extensionDetail.connectionUnknown")}
						</p>
					</div>
				</ComponentSection>
			) : null}

			<section className="extension-detail-docs" data-extension-docs>
				<div className="extension-detail-docs-head">
					<h2>{docsTitle}</h2>
				</div>
				{catalog ? <p className="extension-detail-catalog-note">{catalog.notes.join(" ")}</p> : null}
				<div className="extension-detail-tab-body">
					{document ? (
						<MarkdownView
							source={document.body}
							labels={labels}
							className="extension-detail-markdown message-body"
							onCopyCode={(code) => copyText(code, null)}
							copiedLabel={t("copied")}
						/>
					) : (
						<EmptyState>{t("extensionDetail.missingDocument", { filename })}</EmptyState>
					)}
				</div>
			</section>
		</section>
	);
}
