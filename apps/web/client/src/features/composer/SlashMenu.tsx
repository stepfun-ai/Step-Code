/**
 * The composer's slash menu. Typing `/word` as the whole prompt — or after the
 * command chips already staged, since commands stack — lists, in two
 * groups, the commands and the skills that fuzzy-match it, scored like the
 * CLI's autocomplete:
 *
 * - a command inserts `/<name> ` so the user can add arguments; the kernel
 *   runs it when the prompt is sent;
 * - `/mcp` opens the MCP server list in place (the kernel's `/mcp` only prints
 *   through a terminal notification, which the Web host does not have);
 * - each prompt command (a plugin's `commands/*.md`, or the user's or the
 *   project's prompt templates) inserts `/<name> `, which the kernel expands
 *   into the template when the prompt is sent;
 * - each skill inserts `/skill:<name> `, which the kernel expands into the
 *   skill's instructions when the prompt is sent.
 */

import { Fragment, type ReactNode, type RefObject, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useT } from "../../i18n";
import { api, errorMessage, workspaceApi } from "../../lib/api";
import { cx } from "../../lib/format";
import { activeCwd } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import type { McpServerStatus, WebPromptCommand, WebSkill } from "../../state/types";
import { Icon, useDismiss } from "../../ui";
import { matchText, type SlashItem, slashGroups, slashSections } from "./slash-groups";

export { type SlashItem, slashQuery } from "./slash-groups";

/** The title with the characters the query matched in order shown strong. */
function Highlighted({ text, query }: { readonly text: string; readonly query: string }) {
	const wanted = query.toLowerCase().replace(/[-_:\s/]+/g, "");
	const parts: ReactNode[] = [];
	let next = 0;
	let run = "";
	let strong = false;
	const flush = () => {
		if (run) parts.push(strong ? <strong key={parts.length}>{run}</strong> : <span key={parts.length}>{run}</span>);
		run = "";
	};
	for (const character of text) {
		const hit = next < wanted.length && character.toLowerCase() === wanted[next];
		if (hit) next += 1;
		if (hit !== strong) {
			flush();
			strong = hit;
		}
		run += character;
	}
	flush();
	return <span className="slash-item-title">{parts}</span>;
}

/** What the menu lists beyond its own commands: skills and prompt commands. */
interface SlashResources {
	readonly skills: readonly WebSkill[];
	readonly commands: readonly WebPromptCommand[];
}

const EMPTY_RESOURCES: SlashResources = { skills: [], commands: [] };
const resourceCache = new Map<string, SlashResources>();

/** Skills and prompt commands of the current session, or of the draft's folder; cached per session / folder. */
function useSlashResources(open: boolean): SlashResources {
	const sessionId = useAppStore((state) => state.current?.id ?? "");
	const cwd = useAppStore((state) => activeCwd(state));
	const key = sessionId ? `session:${sessionId}` : `cwd:${cwd}`;
	const [resources, setResources] = useState<SlashResources>(() => resourceCache.get(key) ?? EMPTY_RESOURCES);
	useEffect(() => {
		if (!open) return;
		setResources(resourceCache.get(key) ?? EMPTY_RESOURCES);
		let live = true;
		const path = sessionId ? `/api/v1/sessions/${sessionId}/skills` : workspaceApi(cwd, "/skills");
		api<{ skills?: WebSkill[]; commands?: WebPromptCommand[] }>(path)
			.then((data) => {
				const next = { skills: data.skills ?? [], commands: data.commands ?? [] };
				resourceCache.set(key, next);
				if (live) setResources(next);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [open, key, sessionId, cwd]);
	return resources;
}

const MCP_ORDER: Readonly<Record<McpServerStatus["status"], number>> = {
	connected: 0,
	connecting: 1,
	failed: 2,
	disabled: 3,
};

/** The MCP server list, refreshed while any server is still connecting. */
function McpServers() {
	const t = useT();
	const [servers, setServers] = useState<McpServerStatus[] | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		let live = true;
		let timer = 0;
		const load = async () => {
			try {
				const data = await api<{ servers: McpServerStatus[] }>("/api/v1/mcp");
				if (!live) return;
				setServers(data.servers);
				setError("");
				if (data.servers.some((server) => server.status === "connecting")) timer = window.setTimeout(load, 1500);
			} catch (caught) {
				if (live) setError(errorMessage(caught));
			}
		};
		void load();
		return () => {
			live = false;
			window.clearTimeout(timer);
		};
	}, []);
	const sorted = [...(servers ?? [])].sort(
		(left, right) => MCP_ORDER[left.status] - MCP_ORDER[right.status] || left.name.localeCompare(right.name),
	);
	return (
		<div className="slash-mcp">
			<div className="slash-mcp-head">
				<button
					type="button"
					className="slash-mcp-back"
					aria-label={t("slashBack")}
					onClick={() => setUi({ slashMenu: "commands" })}
				>
					<Icon name="chevronLeft" size="sm" />
				</button>
				<Icon name="mcp" size="sm" />
				<span className="slash-mcp-title">{t("mcpServers")}</span>
				{servers ? (
					<span className="slash-mcp-count">
						{t("mcpConnectedCount", {
							count: servers.filter((server) => server.status === "connected").length,
							total: servers.length,
						})}
					</span>
				) : null}
			</div>
			{error ? <div className="slash-empty">{error}</div> : null}
			{!error && !servers ? <div className="slash-empty">{t("mcpLoading")}</div> : null}
			{servers && !servers.length ? <div className="slash-empty">{t("mcpNone")}</div> : null}
			{sorted.length ? (
				<ul className="slash-mcp-list">
					{sorted.map((server) => (
						<li key={server.name} className={cx("slash-mcp-server", server.status)}>
							<span className="slash-mcp-dot" aria-hidden="true" />
							<span className="slash-mcp-name">{server.name}</span>
							<span className="slash-mcp-state">{t(`mcpStatus.${server.status}`)}</span>
							<span className="slash-mcp-tools">
								{server.status === "connected" ? t("mcpToolCount", { count: server.toolCount }) : ""}
							</span>
							{server.error ? <p className="slash-mcp-error">{server.error}</p> : null}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

export interface SlashMenuHandle {
	/** Handle a key typed in the prompt; true when the menu used it. */
	readonly key: (key: string) => boolean;
}

export interface SlashMenuProps {
	readonly handle: RefObject<SlashMenuHandle | null>;
	/** The prompt: pressing in it does not dismiss the menu. */
	readonly promptRef: RefObject<HTMLDivElement | null>;
	/** The prompt's slash query, or null when the text beside the lead chips is not a single `/word`. */
	readonly query: string | null;
	readonly onPick: (item: SlashItem) => void;
}

export function SlashMenu({ handle, promptRef, query, onPick }: SlashMenuProps) {
	const t = useT();
	const view = useAppStore((state) => state.ui.slashMenu);
	const resources = useSlashResources(view === "commands");
	const groups =
		view === "commands" && query !== null ? slashGroups(query, resources.skills, t, resources.commands) : null;
	// Keyboard selection runs through every group as one list.
	const items = groups ? [...groups.commands, ...groups.prompts, ...groups.skills] : [];
	const [active, setActive] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const selected = Math.min(active, Math.max(0, items.length - 1));
	const highlight = matchText(query ?? "");

	// A new query starts from the best match.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the query is the trigger.
	useEffect(() => setActive(0), [query]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the selection is the trigger.
	useEffect(() => {
		listRef.current?.querySelector(".slash-item.active")?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	useImperativeHandle(
		handle,
		() => ({
			key: (key) => {
				if (view !== "commands" || !items.length) return false;
				if (key === "ArrowDown" || key === "ArrowUp") {
					const step = key === "ArrowDown" ? 1 : -1;
					setActive((selected + step + items.length) % items.length);
					return true;
				}
				if (key === "Enter" || key === "Tab") {
					onPick(items[selected]);
					return true;
				}
				return false;
			},
		}),
		[view, items, selected, onPick],
	);

	const open = view === "mcp" || (view === "commands" && items.length > 0);
	useDismiss({
		enabled: view !== null,
		insideRefs: [rootRef, promptRef],
		escape: false,
		onDismiss: () => setUi({ slashMenu: null }),
	});
	const renderItem = (item: SlashItem, index: number) => (
		<div
			key={`${item.kind}:${item.key}`}
			role="option"
			tabIndex={-1}
			aria-selected={index === selected}
			className={cx("slash-item", item.kind, index === selected && "active")}
			onMouseEnter={() => setActive(index)}
			// Keep focus in the prompt.
			onMouseDown={(event) => event.preventDefault()}
			onClick={() => onPick(item)}
			onKeyDown={() => {}}
		>
			{item.kind === "skill" ? <Icon name="cube" size="sm" /> : null}
			{item.kind === "prompt" ? <Icon name="puzzle" size="sm" /> : null}
			<Highlighted text={item.title} query={highlight} />
			<span className="slash-item-desc">{item.description}</span>
			{item.kind === "mcp" ? <Icon className="slash-item-more" name="chevronRight" size="sm" /> : null}
		</div>
	);
	// Groups with no items are not rendered: no heading over an empty list.
	const sections = groups
		? slashSections(groups, { commands: t("slashCommands"), prompts: t("slashPrompts"), skills: t("slashSkills") })
		: [];

	return (
		<div className="slash-menu" id="slashMenu" ref={rootRef} hidden={!open}>
			{view === "mcp" ? (
				<McpServers />
			) : (
				<div className="slash-list" role="listbox" aria-label={t("slashCommands")} ref={listRef}>
					{sections.map((section) => (
						<Fragment key={section.id}>
							<div className="slash-group" role="presentation">
								{section.label}
							</div>
							{section.items.map((item, index) => renderItem(item, section.offset + index))}
						</Fragment>
					))}
				</div>
			)}
		</div>
	);
}
