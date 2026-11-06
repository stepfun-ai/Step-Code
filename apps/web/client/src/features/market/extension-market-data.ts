import { normalizeExtensionDescription } from "../../lib/extension-text";
import type { McpServerConfig, SettingsMcpServer, SettingsPluginCatalog, SettingsSkill } from "../../state/types";
import catalog from "./catalog/catalog.json";

export type MarketKind = "plugins" | "skills";
export type MarketTab = MarketKind | "connectors";
export const MARKET_CATEGORIES = ["all", "office", "creative", "code", "other"] as const;
export type MarketCategory = (typeof MARKET_CATEGORIES)[number];

export interface MarketDocument {
	readonly filename: string;
	readonly raw: string;
	readonly body: string;
	readonly version: string;
	readonly publisher?: string;
	readonly license?: string;
	readonly packageName?: string;
	readonly sourceLabel: string;
	readonly sourceUrl?: string;
	readonly registryId?: string;
	readonly skillSha256?: string;
	readonly files: readonly string[];
	readonly versionNoteKey?: string;
}

export interface CatalogItem {
	readonly name: string;
	readonly description?: string;
	readonly transport?: string;
}

export interface CatalogItems {
	readonly skills: readonly CatalogItem[];
	readonly connectors: readonly CatalogItem[];
	readonly commands: readonly CatalogItem[];
}

export interface CatalogConnection {
	readonly transport: "http" | "stdio" | "unknown";
	readonly auth: "oauth" | "bearer" | "header" | "env" | "apiKey" | "unknown";
	readonly url: string;
	readonly source: "manifest" | "readme" | "none";
	readonly configuration?: McpServerConfig;
	readonly serverName?: string;
	readonly evidence?: string;
}

export interface CatalogInfo {
	readonly package: string;
	readonly identifier: string;
	readonly components: string;
	readonly items: CatalogItems;
	readonly connection?: CatalogConnection;
	readonly notes: readonly string[];
	readonly path: string;
}

export interface MarketDetailEntry {
	readonly id: string;
	readonly kind: MarketTab;
	readonly name: string;
	readonly description: string;
	readonly example: "catalog";
	readonly categories: readonly MarketCategory[];
	readonly selfMade: boolean;
	readonly downloads?: number;
	readonly logo?: string;
	readonly catalog?: CatalogInfo;
	readonly installed?: boolean;
	readonly installedSkill?: SettingsSkill;
	readonly installedPlugin?: SettingsPluginCatalog["installed"][number];
	readonly installedConnector?: SettingsMcpServer;
	readonly document?: MarketDocument;
}

interface CatalogDocument {
	readonly filename: string;
	readonly path: string;
	readonly raw: string;
	readonly sha256: string;
}

interface CatalogEntry {
	readonly id: string;
	readonly kind: MarketKind | "connectors";
	readonly package: string;
	readonly identifier: string;
	readonly name: string;
	readonly description: string;
	readonly version: string;
	readonly publisher: string;
	readonly license: string;
	readonly categories: readonly MarketCategory[];
	readonly components: string;
	readonly items: CatalogItems;
	readonly connection?: CatalogConnection;
	readonly files: readonly string[];
	readonly logo?: string;
	readonly notes: readonly string[];
	/** StepFun's own entry, marked with the official badge. */
	readonly selfMade?: boolean;
	readonly document: CatalogDocument;
}

interface CatalogFile {
	readonly schemaVersion: number;
	readonly source: {
		readonly label: string;
		readonly path: string;
		readonly index: string;
		readonly statement: string;
	};
	readonly entries: readonly CatalogEntry[];
}

const catalogFile = catalog as unknown as CatalogFile;
if (catalogFile.schemaVersion !== 1) throw new Error("Unsupported extension catalog version");

/**
 * Logo URLs come from Vite's asset graph. Resolved on first use, so a bundler
 * without `import.meta.glob` (the server-render test) can still import this module.
 */
let logoUrls: Record<string, string> | undefined;
function logoUrlFor(file: string): string | undefined {
	logoUrls ??= import.meta.glob("./catalog/logos/*", {
		eager: true,
		query: "?url",
		import: "default",
	}) as Record<string, string>;
	return logoUrls[`./catalog/logos/${file}`];
}
export const catalogSource = catalogFile.source;
export const catalogPackages = catalogFile.entries;

function stripFrontmatter(raw: string): string {
	return raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
}

function documentFor(entry: CatalogEntry): MarketDocument {
	return {
		filename: entry.document.filename,
		raw: entry.document.raw,
		body: entry.kind === "skills" ? stripFrontmatter(entry.document.raw) : entry.document.raw,
		skillSha256: entry.kind === "skills" ? entry.document.sha256 : undefined,
		version: entry.version,
		publisher: entry.publisher || undefined,
		license: entry.license || undefined,
		sourceLabel: `${catalogSource.label} · ${entry.package}`,
		files: entry.files,
	};
}

export function marketEntries(kind: MarketTab): MarketDetailEntry[] {
	return catalogFile.entries
		.filter((entry) => entry.kind === kind)
		.map((entry) => ({
			id: entry.id,
			kind,
			name: entry.name,
			description: normalizeExtensionDescription(entry.description) || entry.components,
			example: "catalog",
			categories: entry.categories,
			selfMade: entry.selfMade ?? false,
			logo: entry.logo ? logoUrlFor(entry.logo) : undefined,
			catalog: {
				package: entry.package,
				identifier: entry.identifier,
				components: entry.components,
				items: entry.items ?? { skills: [], connectors: [], commands: [] },
				connection: entry.connection,
				notes: entry.notes,
				path: `${catalog.source.label}/${entry.package}`,
			},
			document: documentFor(entry),
		}));
}

/** Match catalog skills by published name and, when present, the recorded content fingerprint. */
export function applySkillInstallations(
	entries: MarketDetailEntry[],
	skills: readonly SettingsSkill[],
): MarketDetailEntry[] {
	return entries.map((entry) => {
		if (entry.kind !== "skills") return entry;
		const document = entry.document;
		const installedSkill = skills.find(({ installation, catalogId, source }) => {
			if (source !== "user") return false;
			if (installation && document?.skillSha256) return installation.skillSha256 === document.skillSha256;
			return catalogId === entry.id;
		});
		return { ...entry, installed: Boolean(installedSkill), installedSkill };
	});
}

export function applyPluginInstallations(
	entries: MarketDetailEntry[],
	catalog?: SettingsPluginCatalog,
): MarketDetailEntry[] {
	return entries.map((entry) => {
		if (entry.kind !== "plugins" || !entry.catalog) return entry;
		const installedPlugin = catalog?.installed?.find((plugin) => plugin.id === entry.catalog?.identifier);
		return { ...entry, installed: Boolean(installedPlugin), installedPlugin };
	});
}

export function applyConnectorInstallations(
	entries: MarketDetailEntry[],
	servers: readonly SettingsMcpServer[],
): MarketDetailEntry[] {
	return entries.map((entry) => {
		if (entry.kind !== "connectors") return entry;
		const server = servers.find((server) => server.name === entry.catalog?.connection?.serverName);
		return { ...entry, installed: Boolean(server), installedConnector: server };
	});
}

export function filterEntries(
	entries: readonly MarketDetailEntry[],
	category: MarketCategory,
	query: string,
): MarketDetailEntry[] {
	const needle = query.trim().toLocaleLowerCase();
	return entries.filter(
		(entry) =>
			(category === "all" || entry.categories.includes(category)) &&
			`${entry.name} ${entry.description} ${entry.catalog?.components ?? ""} ${entry.catalog?.package ?? ""}`
				.toLocaleLowerCase()
				.includes(needle),
	);
}
