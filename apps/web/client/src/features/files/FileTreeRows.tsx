/**
 * `#fileTreeBody` rows (legacy `buildTreeRow`, `appendTreeLevel`, `treeNote`,
 * `renderTree`, `handleTreeKeydown`; app.js 1448-1521, 1559-1578).
 *
 * Rows are keyed by path, so a re-render keeps the focused row focused, which
 * the legacy code restored by hand after rebuilding the list.
 */

import type { KeyboardEvent, ReactNode } from "react";
import { type TranslateFn, useT } from "../../i18n";
import { cx } from "../../lib/format";
import { type TreeState, useAppStore } from "../../state/store";
import type { TreeEntry } from "../../state/types";
import { EmptyState, Icon, LEGACY_ICONS } from "../../ui";
import { activateTreeEntry, toggleTreeDirectory } from "./actions";

interface RowProps {
	readonly entry: TreeEntry;
	readonly level: number;
	readonly detail?: string;
	/** Search results show neither twisties nor expanded state. */
	readonly searching: boolean;
	readonly expanded: boolean;
	readonly active: boolean;
}

function treeRows(row: HTMLElement): HTMLElement[] {
	const body = row.closest("#fileTreeBody");
	return body ? [...body.querySelectorAll<HTMLElement>(".file-row")] : [];
}

function TreeRow({ entry, level, detail = "", searching, expanded, active }: RowProps) {
	const directory = entry.kind === "directory";
	const isExpanded = directory && !searching && expanded;
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const row = event.currentTarget;
		const rows = treeRows(row);
		const index = rows.indexOf(row);
		const toggles = directory && !searching;
		if (event.key === "Enter" || event.key === " ") activateTreeEntry(entry.path, entry.kind);
		else if (event.key === "ArrowDown") rows[index + 1]?.focus();
		else if (event.key === "ArrowUp") rows[index - 1]?.focus();
		else if (event.key === "ArrowRight" && toggles) toggleTreeDirectory(entry.path, true);
		else if (event.key === "ArrowLeft" && toggles && row.classList.contains("expanded"))
			toggleTreeDirectory(entry.path, false);
		else return;
		event.preventDefault();
	};
	return (
		<div
			className={cx(
				"file-row",
				directory && "directory",
				isExpanded && "expanded",
				!directory && active && "active",
			)}
			role="treeitem"
			tabIndex={0}
			data-path={entry.path}
			data-kind={entry.kind}
			title={entry.path}
			style={{ paddingLeft: `${6 + level * 14}px` }}
			aria-level={level + 1}
			aria-expanded={directory && !searching ? isExpanded : undefined}
			onClick={() => activateTreeEntry(entry.path, entry.kind)}
			onKeyDown={onKeyDown}
		>
			<span className="file-twisty">
				{directory && !searching ? <Icon name="chevronRight" size="menu" /> : null}
			</span>
			{directory ? <Icon name={isExpanded ? "open" : "folder"} size="sm" /> : <Icon {...LEGACY_ICONS.file} />}
			<span className="file-name">{entry.name}</span>
			{detail ? <small className="file-detail">{detail}</small> : null}
		</div>
	);
}

function TreeNote({ text, level }: { readonly text: string; readonly level: number }) {
	return (
		<EmptyState className="file-note" style={{ paddingLeft: `${24 + level * 14}px` }}>
			{text}
		</EmptyState>
	);
}

/** Path of the file shown in the active preview tab, when it belongs to this tree. */
function useActivePath(cwd: string): string | undefined {
	return useAppStore((state) => {
		const tab = state.preview.tabs[state.preview.active];
		return tab?.kind === "file" && tab.cwd === cwd ? tab.path : undefined;
	});
}

function appendLevel(
	out: ReactNode[],
	tree: TreeState,
	path: string,
	level: number,
	activePath: string | undefined,
	t: TranslateFn,
): void {
	const entries = tree.children.get(path);
	if (!entries) {
		const text = tree.errors.get(path) ?? (tree.loading.has(path) ? t("loadingTree") : "");
		if (text) out.push(<TreeNote key={`note:${path}`} text={text} level={level} />);
		return;
	}
	if (!entries.length && path) out.push(<TreeNote key={`empty:${path}`} text={t("emptyFolder")} level={level} />);
	for (const entry of entries) {
		const expanded = tree.expanded.has(entry.path);
		out.push(
			<TreeRow
				key={`row:${entry.path}`}
				entry={entry}
				level={level}
				searching={false}
				expanded={expanded}
				active={activePath === entry.path}
			/>,
		);
		if (entry.kind === "directory" && expanded) appendLevel(out, tree, entry.path, level + 1, activePath, t);
	}
	if (tree.truncated.has(path))
		out.push(<TreeNote key={`truncated:${path}`} text={t("listTruncated")} level={level} />);
}

function searchRows(tree: TreeState, results: readonly TreeEntry[], activePath: string | undefined, t: TranslateFn) {
	const out: ReactNode[] = results.map((entry) => (
		<TreeRow
			key={`row:${entry.path}`}
			entry={entry}
			level={0}
			detail={entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : ""}
			searching
			expanded={false}
			active={activePath === entry.path}
		/>
	));
	if (!results.length) out.push(<EmptyState key="no-match">{t("noMatchingFiles")}</EmptyState>);
	else if (tree.resultsTruncated) out.push(<TreeNote key="search-truncated" text={t("searchTruncated")} level={0} />);
	return out;
}

/** The rows of the current tree, or of the current name search. */
export function FileTreeRows() {
	const t = useT();
	const tree = useAppStore((state) => state.tree);
	const activePath = useActivePath(tree.cwd);
	// Nothing is drawn until a workspace tree has been opened (legacy renderTree ran only then).
	if (!tree.cwd) return null;
	if (tree.results) return <>{searchRows(tree, tree.results, activePath, t)}</>;
	const out: ReactNode[] = [];
	appendLevel(out, tree, "", 0, activePath, t);
	if (!out.length) out.push(<EmptyState key="empty-root">{t("emptyFolder")}</EmptyState>);
	return <>{out}</>;
}
