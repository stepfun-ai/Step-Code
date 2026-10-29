/**
 * Secondary panels that open from `#plusMenu`'s 更多 rows: a panel
 * flies out to the right of the menu with a search field on top and a list
 * below. Plugins and skills share `PickerPanel` (one async load, then filter);
 * the session picker reads the store instead and packages the picked
 * conversation into a context chip.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { formatRelativeTime, useT } from "../../i18n";
import { api, errorMessage } from "../../lib/api";
import { sessionTitle } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { SettingsSkill } from "../../state/types";
import { Icon, SearchInput } from "../../ui";
import { openSettings } from "../settings/actions";

/** `GET /api/v1/settings/plugins` catalog (openapi.yaml "Plugin catalog"). */
interface InstalledPlugin {
	readonly id: string;
	readonly name: string;
	readonly version?: string;
	readonly description?: string;
}

interface AvailablePlugin {
	readonly name: string;
	readonly description?: string;
	readonly marketplace?: string;
	readonly installed?: boolean;
}

/** One row of the plugin panel: installed first, then what the marketplaces offer. */
interface PluginRow {
	readonly kind: "installed" | "available";
	readonly key: string;
	readonly name: string;
	readonly hint?: string;
	readonly description?: string;
}

/**
 * Hover moves between the 更多 rows switch panels, which unmounts and remounts
 * them; the in-flight result is cached so a revisit shows data at once instead
 * of flashing 加载中 again. A failed request drops the cache for a retry.
 */
const requestCache = new Map<string, Promise<readonly unknown[]>>();

function cachedRequest<P, T extends readonly unknown[]>(path: string, pick: (payload: P) => T): Promise<T> {
	let pending = requestCache.get(path) as Promise<T> | undefined;
	if (!pending) {
		pending = api<P>(path).then(
			(payload) => pick(payload),
			(error) => {
				requestCache.delete(path);
				throw error;
			},
		);
		requestCache.set(path, pending as Promise<readonly unknown[]>);
	}
	return pending;
}

/**
 * A hung request (a busy host moment, a dropped connection) never settles, and
 * because `requestCache` holds the promise itself, every later open would
 * replay the same dead request and show 加载中 until a page reload. Race the
 * load with this timeout, and on expiry drop the cache so the next open — or
 * the retry row — starts a fresh request.
 */
const REQUEST_TIMEOUT_MS = 8000;

const PANEL_PATHS = ["/api/v1/settings/plugins", "/api/v1/settings/skills"] as const;

function loadWithTimeout<T>(load: () => Promise<readonly T[]>): Promise<readonly T[]> {
	const timeout = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("panel request timed out")), REQUEST_TIMEOUT_MS);
	});
	return Promise.race([load(), timeout]).catch((error: unknown) => {
		for (const path of PANEL_PATHS) requestCache.delete(path);
		throw error;
	});
}

const loadPlugins = () =>
	loadWithTimeout(() =>
		cachedRequest(
			"/api/v1/settings/plugins",
			(catalog: {
				installed?: readonly InstalledPlugin[];
				available?: readonly AvailablePlugin[];
			}): readonly PluginRow[] => [
				...(catalog.installed ?? []).map(
					(plugin): PluginRow => ({
						kind: "installed",
						key: plugin.id,
						name: plugin.name,
						hint: plugin.version,
						description: plugin.description,
					}),
				),
				...(catalog.available ?? [])
					.filter((plugin) => !plugin.installed)
					.map(
						(plugin): PluginRow => ({
							kind: "available",
							key: `available:${plugin.name}`,
							name: plugin.name,
							hint: plugin.marketplace,
							description: plugin.description,
						}),
					),
			],
		),
	);
const loadSkills = () =>
	loadWithTimeout(() =>
		cachedRequest("/api/v1/settings/skills", (result: { skills?: readonly SettingsSkill[] }) => result.skills ?? []),
	);

/**
 * Shared frame: search field, a scrollable list, one footer action. The search
 * input is uncontrolled and read through `onInputCapture` (ui convention 8).
 */
function SubPanelFrame({
	placeholder,
	footer,
	children,
}: {
	readonly placeholder: string;
	readonly footer: ReactNode;
	readonly children: (query: string) => ReactNode;
}) {
	const [query, setQuery] = useState("");
	return (
		<div className="plus-sub">
			<div className="plus-sub-search">
				<SearchInput
					placeholder={placeholder}
					defaultValue=""
					onInputCapture={(event) => setQuery(event.currentTarget.value)}
				/>
			</div>
			<div className="plus-sub-list">{children(query.trim().toLowerCase())}</div>
			<div className="plus-sub-footer">{footer}</div>
		</div>
	);
}

/** One list row: an optional light-purple kind icon, name, one-line description. */
function SubRow({
	name,
	hint,
	description,
	icon,
	onClick,
	faded = false,
}: {
	readonly name: string;
	readonly hint?: string;
	readonly description?: string;
	/** Kind marker matching the staged chip: the wrench marks a skill, the puzzle a plugin. */
	readonly icon?: "wrench" | "puzzle";
	readonly onClick: () => void;
	readonly faded?: boolean;
}) {
	return (
		<button type="button" className={faded ? "plus-sub-row plus-sub-row--faded" : "plus-sub-row"} onClick={onClick}>
			{icon ? <Icon className={`plus-sub-kind plus-sub-kind--${icon}`} name={icon} size="md" /> : null}
			<span className="plus-sub-body">
				<span className="plus-sub-name">
					{name}
					{hint ? <span className="plus-sub-hint">{hint}</span> : null}
				</span>
				{description ? <span className="plus-sub-desc">{description}</span> : null}
			</span>
		</button>
	);
}

/** What `PickerPanel` needs to know about one entry. */
interface PickerItem {
	readonly key: string;
	/** Lowercased against the search query; undefined entries never match. */
	readonly matchText: readonly (string | undefined)[];
	readonly row: Pick<SubRowProps, "name" | "hint" | "description" | "icon" | "faded" | "onClick">;
}

type SubRowProps = Parameters<typeof SubRow>[0];

/**
 * The plugins and skills panels are one shape: load once, filter by the search
 * field, empty/loading/error states, a footer action. `load` must be a stable
 * reference (module const) — it is the effect's only dependency.
 */
function PickerPanel<T>({
	placeholder,
	emptyKey,
	footer,
	load,
	item,
}: {
	readonly placeholder: string;
	/** i18n key shown when no entry matches the query. */
	readonly emptyKey: string;
	readonly footer: ReactNode;
	readonly load: () => Promise<readonly T[]>;
	readonly item: (entry: T) => PickerItem;
}) {
	const t = useT();
	const [entries, setEntries] = useState<readonly T[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const run = useCallback(() => {
		load().then(setEntries, (caught) => setError(errorMessage(caught)));
	}, [load]);
	useEffect(() => run(), [run]);
	const retry = () => {
		setEntries(null);
		setError(null);
		run();
	};
	return (
		<SubPanelFrame placeholder={placeholder} footer={footer}>
			{(query) => {
				if (error) {
					return (
						<button type="button" className="plus-sub-empty plus-sub-retry" onClick={retry}>
							{t("plusLoadFailed")} · {t("plusRetry")}
						</button>
					);
				}
				if (!entries) return <div className="plus-sub-empty">{t("plusLoading")}</div>;
				const hits = entries
					.map(item)
					.filter((entry) => entry.matchText.some((text) => text?.toLowerCase().includes(query)));
				if (!hits.length) return <div className="plus-sub-empty">{t(emptyKey)}</div>;
				return hits.map((entry) => <SubRow key={entry.key} {...entry.row} />);
			}}
		</SubPanelFrame>
	);
}

function footerButton(label: string, onClick: () => void) {
	return (
		<button type="button" className="plus-sub-footer-action" onClick={onClick}>
			{label}
		</button>
	);
}

/**
 * Installed plugins first, then the marketplaces' offers. Every pick stages a
 * purple puzzle chip in the composer: an available plugin leads the next
 * message with `/plugin install <name>`, an installed one rides as a use note
 * (the kernel has no invocation command for a plugin — its MCP servers, skills
 * and commands are what get used).
 */
export function PluginsPanel({ onPick }: { readonly onPick: (name: string, installed: boolean) => void }) {
	const t = useT();
	return (
		<PickerPanel
			placeholder={t("settingsPluginsSearch")}
			emptyKey="settingsPluginsNoneAvailable"
			footer={footerButton(t("plusManagePlugins"), () => openSettings("plugins"))}
			load={loadPlugins}
			item={(row: PluginRow) => ({
				key: row.key,
				matchText: [row.name, row.description],
				row: {
					name: row.name,
					icon: "puzzle",
					hint: row.kind === "available" ? `${row.hint ?? ""} · ${t("plugInstallHint")}` : row.hint,
					description: row.description,
					onClick: () => onPick(row.name, row.kind === "installed"),
				},
			})}
		/>
	);
}

/** Every skill the Settings page lists; picking one stages `/skill:<name> `. */
export function SkillsPanel({ onPick }: { readonly onPick: (name: string) => void }) {
	const t = useT();
	return (
		<PickerPanel
			placeholder={t("settingsSkillsSearch")}
			emptyKey="settingsSkillsEmpty"
			footer={footerButton(t("plusManageSkills"), () => openSettings("skills"))}
			load={loadSkills}
			item={(skill: SettingsSkill) => ({
				key: skill.id,
				matchText: [skill.name, skill.description],
				row: {
					name: skill.name,
					icon: "wrench",
					hint: skill.source === "plugin" ? skill.pluginName : undefined,
					description: skill.description,
					faded: !skill.enabled,
					onClick: () => onPick(skill.name),
				},
			})}
		/>
	);
}

/** Pick another conversation; the parent packages its context into the prompt. */
export function SessionsPanel({ onPick }: { readonly onPick: (id: string) => void }) {
	const t = useT();
	const sessions = useAppStore((state) => state.sessions);
	const rows = useMemo(
		() =>
			[...sessions]
				.filter((session) => session.cwdAvailable !== false)
				.sort((a, b) => new Date(b.modified ?? 0).getTime() - new Date(a.modified ?? 0).getTime()),
		[sessions],
	);
	return (
		<SubPanelFrame placeholder={t("searchPlaceholder")} footer={null}>
			{(query) => {
				const hits = rows.filter((session) =>
					[session.name, session.firstMessage, session.cwd].some((text) => text?.toLowerCase().includes(query)),
				);
				if (!hits.length) return <div className="plus-sub-empty">{t("noSearchResults")}</div>;
				return hits.map((session) => (
					<SubRow
						key={session.id}
						name={sessionTitle(session)}
						hint={formatRelativeTime(session.modified)}
						description={session.firstMessage}
						onClick={() => onPick(session.id)}
					/>
				));
			}}
		</SubPanelFrame>
	);
}
