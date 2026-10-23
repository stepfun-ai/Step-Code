/**
 * File tree and preview actions with fixed names, callable from any feature.
 * Foundation ported them from legacy app.js; the files feature owns this file.
 *
 * The tree is immutable state (`state.tree`, see state/store.ts). Expanded
 * folders are also remembered per workspace in `state.treeExpandedByCwd`;
 * `updateExpanded` keeps both in step.
 */

import { t } from "../../i18n";
import { api, errorMessage, localFileApi, workspaceApi } from "../../lib/api";
import { resolveFileReference } from "../../lib/file-references";
import { ancestorPaths } from "../../lib/format";
import { readStoredInt, STORAGE_KEYS, writeStorage } from "../../lib/storage";
import { collectTurnChanges } from "../../lib/turn-changes";
import { activeRightPanel, closeRightPanel, openRightPanel } from "../../state/right-panel";
import { copyText, forgetSideAnswer, showError } from "../../state/session";
import {
	emptyTree,
	type FilePreviewTab,
	getState,
	mapWith,
	mapWithout,
	type PreviewTab,
	setPreview,
	setState,
	setToggled,
	setTree,
	setUi,
	setWith,
	setWithout,
	type TreeState,
} from "../../state/store";
import type { TreeEntry, WorkspaceFile } from "../../state/types";

/* ── Signals for the tree component ──────────────────────────────────────── */

export type TreeSignal =
	| { readonly type: "reset-search"; readonly focus: boolean }
	| { readonly type: "reveal"; readonly path: string };

const treeListeners = new Set<(signal: TreeSignal) => void>();

/**
 * DOM work the legacy actions did directly: clear (and focus) `#fileTreeSearch`,
 * scroll to and focus a revealed row. The tree component subscribes.
 */
export function subscribeTreeSignals(listener: (signal: TreeSignal) => void): () => void {
	treeListeners.add(listener);
	return () => {
		treeListeners.delete(listener);
	};
}

function emitTreeSignal(signal: TreeSignal): void {
	for (const listener of [...treeListeners]) listener(signal);
}

/* ── Tree ────────────────────────────────────────────────────────────────── */

/** Change `tree.expanded` and remember it for the tree's workspace. */
function updateExpanded(update: (expanded: ReadonlySet<string>) => ReadonlySet<string>): void {
	setState((state) => {
		const expanded = update(state.tree.expanded);
		return {
			tree: { ...state.tree, expanded },
			treeExpandedByCwd: mapWith(state.treeExpandedByCwd, state.tree.cwd, expanded),
		};
	});
}

/** Apply `update` only while the tree still shows `cwd`. */
function updateTreeFor(cwd: string, update: (tree: TreeState) => TreeState): void {
	setTree((tree) => (tree.cwd === cwd ? update(tree) : tree));
}

/**
 * Load one directory level (legacy `loadTreeDirectory`, 1348-1366). The tree is
 * lazy: a repository with a large `node_modules` costs nothing until that
 * folder is expanded.
 */
export async function loadTreeDirectory(path: string): Promise<void> {
	const cwd = getState().tree.cwd;
	updateTreeFor(cwd, (tree) => ({ ...tree, loading: setWith(tree.loading, path) }));
	try {
		const data = await api<{ entries: TreeEntry[]; truncated: boolean }>(workspaceApi(cwd, "/files", { path }));
		updateTreeFor(cwd, (tree) => ({
			...tree,
			children: mapWith(tree.children, path, data.entries),
			truncated: data.truncated ? setWith(tree.truncated, path) : setWithout(tree.truncated, path),
			errors: mapWithout(tree.errors, path),
		}));
	} catch (error) {
		updateTreeFor(cwd, (tree) => ({ ...tree, errors: mapWith(tree.errors, path, errorMessage(error)) }));
	} finally {
		updateTreeFor(cwd, (tree) => ({ ...tree, loading: setWithout(tree.loading, path) }));
	}
}

/** Show the file tree of a workspace in the sidebar (legacy `openTree`, 1368-1392). */
export async function openTree(project: { cwd: string }): Promise<void> {
	const cwd = project.cwd;
	setState((state) => {
		if (state.tree.cwd === cwd) return { tree: { ...state.tree, results: null } };
		// Which folders were open is remembered per workspace for this page load.
		const expanded = state.treeExpandedByCwd.get(cwd) ?? new Set<string>();
		return {
			tree: { ...emptyTree(cwd), expanded },
			treeExpandedByCwd: mapWith(state.treeExpandedByCwd, cwd, expanded),
		};
	});
	setUi({ fileTreeOpen: true });
	emitTreeSignal({ type: "reset-search", focus: true });
	await refreshTree();
}

/** Back to the conversation list (legacy `#fileTreeBack` and Escape). */
export function closeTree(): void {
	setUi({ fileTreeOpen: false });
}

/** Re-read every directory on screen, dropping ones that disappeared (legacy `refreshTree`, 1395-1412). */
export async function refreshTree(): Promise<void> {
	const tree = getState().tree;
	if (!tree.cwd) return;
	const paths = [
		"",
		...[...tree.expanded].filter((path) => ancestorPaths(path).every((parent) => tree.expanded.has(parent))),
	];
	await Promise.all(paths.map((path) => loadTreeDirectory(path)));
	const current = getState().tree;
	if (current.cwd !== tree.cwd) return;
	const gone = [...current.errors.keys()].filter(Boolean);
	if (!gone.length) return;
	updateExpanded((expanded) => {
		const next = new Set(expanded);
		for (const path of gone) next.delete(path);
		return next;
	});
	setTree((latest) => {
		const children = new Map(latest.children);
		const errors = new Map(latest.errors);
		for (const path of gone) {
			children.delete(path);
			errors.delete(path);
		}
		return { ...latest, children, errors };
	});
}

/** Expand or collapse one folder, loading it on first expand (legacy `toggleTreeDirectory`, 1414-1426). */
export function toggleTreeDirectory(path: string, expand = !getState().tree.expanded.has(path)): void {
	if (expand) {
		updateExpanded((expanded) => setWith(expanded, path));
		if (!getState().tree.children.has(path)) void loadTreeDirectory(path);
	} else {
		updateExpanded((expanded) => setWithout(expanded, path));
	}
}

/** Leave search and open the tree down to `path` (legacy `revealInTree`, 1429-1440). */
export async function revealInTree(path: string): Promise<void> {
	emitTreeSignal({ type: "reset-search", focus: false });
	setTree((tree) => ({ ...tree, results: null }));
	for (const directory of [...ancestorPaths(path), path]) {
		updateExpanded((expanded) => setWith(expanded, directory));
		if (!getState().tree.children.has(directory)) await loadTreeDirectory(directory);
	}
	emitTreeSignal({ type: "reveal", path });
}

/* ── Tree search (legacy 1523-1550) ─────────────────────────────────────── */

let treeSearchTimer = 0;
let treeSearchSequence = 0;

/**
 * Name search runs on the server: with a lazy tree the browser only holds the
 * folders already opened, so a client-side filter would miss most of the repo.
 * Debounced by 160 ms; a newer query (or a tree for another workspace) wins.
 */
export function searchTree(query: string): void {
	window.clearTimeout(treeSearchTimer);
	const sequence = ++treeSearchSequence;
	const cwd = getState().tree.cwd;
	if (!query.trim()) {
		updateTreeFor(cwd, (tree) => ({ ...tree, results: null }));
		return;
	}
	treeSearchTimer = window.setTimeout(async () => {
		try {
			const data = await api<{ entries: TreeEntry[]; truncated: boolean }>(
				workspaceApi(cwd, "/search", { q: query }),
			);
			if (sequence !== treeSearchSequence || getState().tree.cwd !== cwd) return;
			updateTreeFor(cwd, (tree) => ({ ...tree, results: data.entries, resultsTruncated: data.truncated }));
		} catch (error) {
			showError(errorMessage(error));
		}
	}, 160);
}

/** Click / Enter on a row (legacy `activateTreeRow`, 1552-1557). */
export function activateTreeEntry(path: string, kind: string): void {
	const tree = getState().tree;
	if (kind === "file") void openFile(tree.cwd, path);
	else if (tree.results) void revealInTree(path);
	else toggleTreeDirectory(path);
}

/* ── Preview ─────────────────────────────────────────────────────────────── */

function sameTab(tab: PreviewTab, cwd: string, path: string, scope?: "local"): tab is FilePreviewTab {
	return tab.kind === "file" && tab.cwd === cwd && tab.path === path && tab.scope === scope;
}

function updateTab(cwd: string, path: string, update: (tab: FilePreviewTab) => FilePreviewTab, scope?: "local"): void {
	setPreview((preview) => ({
		...preview,
		tabs: preview.tabs.map((tab) => (sameTab(tab, cwd, path, scope) ? update(tab) : tab)),
	}));
}

/** Show or hide the preview panel; tabs are kept (legacy `setPreviewOpen`, 1717-1722). */
export function setPreviewOpen(open: boolean): void {
	if (open) openRightPanel(getState().preview.mode);
	else closeRightPanel();
}

/** (Re)read one tab's file from disk (legacy `loadPreviewTab`, 1746-1758). */
export async function loadPreviewTab(cwd: string, path: string, scope?: "local"): Promise<void> {
	updateTab(cwd, path, (tab) => ({ ...tab, loading: true, error: "" }), scope);
	let file: WorkspaceFile | null = null;
	let error = "";
	try {
		file = await api<WorkspaceFile>(
			scope === "local" ? localFileApi("", path) : workspaceApi(cwd, "/file", { path }),
		);
	} catch (caught) {
		error = errorMessage(caught);
	}
	updateTab(cwd, path, (tab) => ({ ...tab, file, error, loading: false }), scope);
}

/** Open a file in a preview tab, reusing an open tab (legacy `openFile`, 1724-1744). */
export async function openFile(cwd: string, path: string, rendered?: boolean, scope?: "local"): Promise<void> {
	openRightPanel("files");
	setPreview((preview) => {
		let index = preview.tabs.findIndex((candidate) => sameTab(candidate, cwd, path, scope));
		let tabs = preview.tabs;
		if (index < 0) {
			tabs = [
				...tabs,
				{
					kind: "file",
					cwd,
					path,
					// Files outside the workspace are read by absolute path; the field
					// stays absent otherwise so tabs stay plain workspace references.
					...(scope === "local" ? { scope: "local" as const } : {}),
					file: null,
					error: "",
					loading: false,
					rendered: rendered ?? false,
				},
			];
			index = tabs.length - 1;
		} else if (rendered !== undefined) {
			tabs = tabs.map((tab, position) => (position === index ? { ...tab, rendered } : tab));
		}
		return { ...preview, tabs, active: index, open: true, mode: "files" };
	});
	const preview = getState().preview;
	const active = preview.tabs[preview.active];
	if (active?.kind !== "file" || !active.file) await loadPreviewTab(cwd, path, scope);
}

/**
 * Message references never navigate the browser. A reference outside the
 * workspace opens read-only by its absolute path rather than widening the
 * host's workspace access.
 */
export async function openFileReference(cwd: string, reference: string, sourcePath = ""): Promise<void> {
	const resolved = resolveFileReference(cwd, reference, sourcePath);
	if (!resolved) {
		showError(t("fileReferenceOutside"));
		return;
	}
	await openFile(cwd, resolved.path, /\.mdx?$/i.test(resolved.path), resolved.scope === "local" ? "local" : undefined);
}

/** Delivery triggers toggle only their own visible file; retained tabs survive closing. */
export async function toggleDeliveryFile(cwd: string, path: string): Promise<void> {
	const state = getState();
	const tab = state.preview.tabs[state.preview.active];
	if (activeRightPanel(state) === "files" && tab && sameTab(tab, cwd, path)) {
		// Keep focus on the conversation trigger instead of moving it to the rail toolbar.
		openRightPanel(null);
		return;
	}
	await openFile(cwd, path, /\.mdx?$/i.test(path));
}

/* ── Turn changes ────────────────────────────────────────────────────────── */

/**
 * Show a turn's changed files in the preview panel; `path` (a shown path)
 * is unfolded and scrolled to.
 */
export function openTurnChanges(turnId: string, path?: string): void {
	openRightPanel("changes");
	setPreview((preview) => {
		const previous = preview.changes?.turnId === turnId ? preview.changes : null;
		return {
			...preview,
			open: true,
			mode: "changes",
			changes: {
				turnId,
				expanded: path ? setWith(previous?.expanded ?? new Set<string>(), path) : (previous?.expanded ?? new Set()),
				focus: path ?? null,
				focusSeq: (preview.changes?.focusSeq ?? 0) + 1,
			},
		};
	});
}

/** Fold or unfold one file's diff in the changes view. */
export function toggleChangedFile(path: string, expand?: boolean): void {
	updateChangesExpansion((expanded) => setToggled(expanded, path, expand));
}

/** Unfold every listed file, or fold them all. */
export function setChangedFilesExpanded(paths: readonly string[]): void {
	updateChangesExpansion(() => new Set(paths));
}

/** A rail open can show the latest turn before an explicit turn has been selected. */
function updateChangesExpansion(update: (expanded: ReadonlySet<string>) => ReadonlySet<string>): void {
	setState((state) => {
		const turns = collectTurnChanges(state.timelineItems, state.current?.cwd ?? "");
		const turn = turns.find((candidate) => candidate.turnId === state.preview.changes?.turnId) ?? turns.at(-1);
		if (!turn) return {};
		const changes =
			state.preview.changes?.turnId === turn.turnId
				? state.preview.changes
				: { turnId: turn.turnId, expanded: new Set<string>(), focus: null, focusSeq: 0 };
		return { preview: { ...state.preview, changes: { ...changes, expanded: update(changes.expanded) } } };
	});
}

/** Back to the file tabs from the changes view. */
export function showPreviewFiles(): void {
	openRightPanel("files");
}

/** Close one tab; closing the last one hides the panel (legacy `closePreviewTab`, 1760-1769). */
export function closePreviewTab(index: number): void {
	const wasShowingFiles = getState().preview.open && getState().preview.mode === "files";
	// A closed side answer stays closed: the host still holds it for the session.
	const closing = getState().preview.tabs[index];
	if (closing?.kind === "btw") forgetSideAnswer(closing.id);
	setPreview((preview) => {
		const tabs = preview.tabs.filter((_tab, position) => position !== index);
		let active = preview.active >= index ? Math.max(0, preview.active - 1) : preview.active;
		let open = preview.open;
		if (!tabs.length) {
			active = -1;
			if (preview.mode === "files") open = false;
		}
		return { ...preview, tabs, active, open };
	});
	if (wasShowingFiles && !getState().preview.tabs.length) closeRightPanel();
}

/** Focus an open tab (legacy tab click / Enter). */
export function selectPreviewTab(index: number): void {
	setPreview((preview) => (preview.active === index ? preview : { ...preview, active: index }));
}

/** Toggle line wrapping and remember it (legacy `#previewWrap`, 1956-1961). */
export function togglePreviewWrap(): void {
	setPreview((preview) => ({ ...preview, wrap: !preview.wrap }));
	writeStorage(STORAGE_KEYS.previewWrap, getState().preview.wrap ? "1" : "0");
}

/** Switch the active Markdown tab between source and rendered (legacy `#previewMode`). */
export function togglePreviewRendered(): void {
	const preview = getState().preview;
	const tab = preview.tabs[preview.active];
	if (tab?.kind !== "file") return;
	updateTab(tab.cwd, tab.path, (current) => ({ ...current, rendered: !current.rendered }), tab.scope);
}

/** Re-read the active tab from disk (legacy `#previewReload`). */
export function reloadActivePreview(): void {
	const preview = getState().preview;
	const tab = preview.tabs[preview.active];
	if (tab?.kind === "file") void loadPreviewTab(tab.cwd, tab.path, tab.scope);
}

/** Copy the active text file (legacy `#previewCopy`). */
export function copyActivePreview(): void {
	const preview = getState().preview;
	const tab = preview.tabs[preview.active];
	if (tab?.kind === "btw") {
		void copyText(tab.text);
		return;
	}
	const file = tab?.file;
	if (file?.kind === "text") void copyText(file.content);
}

/* ── Preview width (legacy 1875-1888) ────────────────────────────────────── */

export const PREVIEW_MIN = 320;
export const PREVIEW_DEFAULT = 420;

export function previewMaxWidth(): number {
	return Math.max(PREVIEW_MIN, Math.round(window.innerWidth * 0.6));
}

/** Clamp and apply `--preview-width`; persist unless `persist` is false. */
export function applyPreviewWidth(width: number, persist = true): number {
	const resolved = Math.min(previewMaxWidth(), Math.max(PREVIEW_MIN, Math.round(width)));
	setUi({ previewWidth: resolved });
	if (persist) writeStorage(STORAGE_KEYS.previewWidth, String(resolved));
	return resolved;
}

/** Startup: the remembered width, or the default (legacy `initPreviewPanel`). */
export function restorePreviewWidth(): void {
	applyPreviewWidth(readStoredInt(STORAGE_KEYS.previewWidth) ?? PREVIEW_DEFAULT, false);
}
