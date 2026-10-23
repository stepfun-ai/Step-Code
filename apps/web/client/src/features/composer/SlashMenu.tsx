/**
 * The composer's slash menu. Typing `/word` as the whole prompt lists, in two
 * groups, the commands and the skills that fuzzy-match it, scored like the
 * CLI's autocomplete:
 *
 * - a command inserts `/<name> ` so the user can add arguments; the kernel
 *   runs it when the prompt is sent;
 * - `/mcp` opens the MCP server list in place (the kernel's `/mcp` only prints
 *   through a terminal notification, which the Web host does not have);
 * - each skill inserts `/skill:<name> `, which the kernel expands into the
 *   skill's instructions when the prompt is sent.
 */

import { Fragment, type ReactNode, type RefObject, useEffect, useImperativeHandle, useRef, useState } from "react";
import { type MessageKey, type TranslateFn, useT } from "../../i18n";
import { api, errorMessage, workspaceApi } from "../../lib/api";
import { cx } from "../../lib/format";
import { fuzzyFilter } from "../../lib/fuzzy";
import { activeCwd } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import type { McpServerStatus, WebSkill } from "../../state/types";
import { Icon, useDismiss } from "../../ui";

export interface SlashItem {
	/**
	 * `command` inserts `/<key> `, `mcp` opens the MCP view, `feedback` opens the
	 * feedback dialog, `skill` inserts `/skill:<key> `.
	 */
	readonly kind: "command" | "mcp" | "feedback" | "skill";
	readonly key: string;
	readonly title: string;
	readonly description: string;
}

/** The commands the menu offers, in display order. */
const SLASH_COMMANDS: readonly { readonly name: string; readonly description: MessageKey }[] = [
	{ name: "goal", description: "goalCommandDesc" },
	{ name: "init", description: "initCommandDesc" },
	{ name: "plan", description: "planCommandDesc" },
	{ name: "btw", description: "btwCommandDesc" },
	{ name: "compact", description: "compactCommandDesc" },
	{ name: "feedback", description: "feedbackCommandDesc" },
	{ name: "mcp", description: "mcpCommandDesc" },
];

/** `find-skills` -> `Find Skills`. */
function skillTitle(name: string): string {
	return name
		.split(/[-_:\s]+/)
		.filter(Boolean)
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

/** The word of a prompt that is a single `/word` (including a `skill:` prefix), or null. */
export function slashQuery(value: string): string | null {
	const match = /^\/(\S*)$/.exec(value);
	return match ? match[1] : null;
}

/** The part of a slash query the items are matched against. */
function matchText(query: string): string {
	return query.replace(/^skill:/i, "");
}

export interface SlashGroups {
	readonly commands: readonly SlashItem[];
	readonly skills: readonly SlashItem[];
}

/**
 * Commands and skills matching `query`, each group best first and in display
 * order when the query is empty. A `skill:` prefix asks for skills only.
 */
export function slashGroups(query: string, skills: readonly WebSkill[], t: TranslateFn): SlashGroups {
	const wanted = matchText(query);
	const commands = /^skill:/i.test(query)
		? []
		: SLASH_COMMANDS.map(
				(command): SlashItem => ({
					kind: command.name === "mcp" ? "mcp" : command.name === "feedback" ? "feedback" : "command",
					key: command.name,
					title: `/${command.name}`,
					description: t(command.description),
				}),
			);
	const skillItems = skills.map(
		(skill): SlashItem => ({
			kind: "skill",
			key: skill.name,
			title: skillTitle(skill.name),
			description: skill.description,
		}),
	);
	return {
		commands: fuzzyFilter(commands, wanted, (item) => item.key),
		skills: fuzzyFilter(skillItems, wanted, (item) => item.key),
	};
}

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

const skillCache = new Map<string, WebSkill[]>();

/** Skills of the current session, or of the draft's folder; cached per session / folder. */
function useSkills(open: boolean): WebSkill[] {
	const sessionId = useAppStore((state) => state.current?.id ?? "");
	const cwd = useAppStore((state) => activeCwd(state));
	const key = sessionId ? `session:${sessionId}` : `cwd:${cwd}`;
	const [skills, setSkills] = useState<WebSkill[]>(() => skillCache.get(key) ?? []);
	useEffect(() => {
		if (!open) return;
		setSkills(skillCache.get(key) ?? []);
		let live = true;
		const path = sessionId ? `/api/v1/sessions/${sessionId}/skills` : workspaceApi(cwd, "/skills");
		api<{ skills: WebSkill[] }>(path)
			.then((data) => {
				skillCache.set(key, data.skills);
				if (live) setSkills(data.skills);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [open, key, sessionId, cwd]);
	return skills;
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
	/** The prompt's slash query, or null when the prompt is not a single `/word`. */
	readonly query: string | null;
	readonly onPick: (item: SlashItem) => void;
}

export function SlashMenu({ handle, promptRef, query, onPick }: SlashMenuProps) {
	const t = useT();
	const view = useAppStore((state) => state.ui.slashMenu);
	const skills = useSkills(view === "commands");
	const groups = view === "commands" && query !== null ? slashGroups(query, skills, t) : null;
	// Keyboard selection runs through both groups as one list.
	const items = groups ? [...groups.commands, ...groups.skills] : [];
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
			<Highlighted text={item.title} query={highlight} />
			<span className="slash-item-desc">{item.description}</span>
			{item.kind === "mcp" ? <Icon className="slash-item-more" name="chevronRight" size="sm" /> : null}
		</div>
	);
	const commandCount = groups?.commands.length ?? 0;
	const sections = groups
		? [
				{ id: "commands", label: t("slashCommands"), items: groups.commands, offset: 0 },
				{ id: "skills", label: t("slashSkills"), items: groups.skills, offset: commandCount },
			].filter((section) => section.items.length > 0)
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
