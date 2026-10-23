/**
 * The preview panel's turn-changes view: a turn picker with the turn's line
 * counts, then one row per changed file that unfolds into its diff. Opened
 * from the change card under a finished turn (features/conversation).
 */

import { type CSSProperties, memo, useLayoutEffect, useMemo, useRef } from "react";
import { useT } from "../../i18n";
import { escapeHtml } from "../../lib/markdown";
import {
	type ChangedFile,
	collectTurnChanges,
	type DiffLine,
	parsedPatch,
	splitPath,
	type TurnChanges,
} from "../../lib/turn-changes";
import { copyText } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import { DiffStat, Icon, IconButton, Menu, MenuItem, Popover, Tooltip } from "../../ui";
import {
	openFile,
	openTurnChanges,
	setChangedFilesExpanded,
	setPreviewOpen,
	showPreviewFiles,
	toggleChangedFile,
} from "./actions";
import { fileLanguage, highlightLines } from "./highlight";

/** Short badge per file kind, as in the reference design: `M↓` for Markdown, `#` for markup and styles. */
function fileBadge(path: string): { readonly label: string; readonly tone: string } {
	const language = fileLanguage(path);
	if (["md", "markdown", "mdx"].includes(language)) return { label: "M↓", tone: "markdown" };
	if (["html", "htm", "css", "scss", "less", "vue", "svelte"].includes(language))
		return { label: "#", tone: "markup" };
	if (["ts", "tsx", "mts", "cts"].includes(language)) return { label: "TS", tone: "script" };
	if (["js", "jsx", "mjs", "cjs"].includes(language)) return { label: "JS", tone: "script" };
	if (["json", "jsonc", "yaml", "yml", "toml"].includes(language)) return { label: "{}", tone: "data" };
	return { label: "", tone: "plain" };
}

function FileBadge({ path }: { readonly path: string }) {
	const badge = fileBadge(path);
	return (
		<span className={`changes-file-badge ${badge.tone}`} aria-hidden="true">
			{badge.label || <Icon name="file" size="xs" />}
		</span>
	);
}

/** `.diff-line` rows of one file's patches, highlighted, as one string (a new file can be long). */
function diffHtml(file: ChangedFile): { html: string; digits: number } {
	const rows: DiffLine[] = [];
	file.patches.forEach((patch, index) => {
		const lines = parsedPatch(patch).lines;
		// Each later patch of the same file starts on its own separator.
		if (index > 0 && lines[0]?.kind !== "hunk") rows.push({ kind: "hunk", text: "" });
		rows.push(...lines);
	});
	const highlighted = highlightLines(
		rows.map((row) => (row.kind === "hunk" ? "" : row.text)).join("\n"),
		fileLanguage(file.path),
	);
	let digits = 1;
	const html = rows
		.map((row, index) => {
			if (row.kind === "hunk") return `<div class="diff-line hunk">${escapeHtml(row.text) || "⋯"}</div>`;
			digits = Math.max(digits, String(row.number ?? "").length);
			return `<div class="diff-line ${row.kind}"><span class="diff-number">${row.number ?? ""}</span><span class="diff-code">${highlighted[index] || " "}</span></div>`;
		})
		.join("");
	return { html, digits };
}

const FileDiff = memo(function FileDiff({ file }: { readonly file: ChangedFile }) {
	const view = useMemo(() => diffHtml(file), [file]);
	return (
		<div
			className="changes-diff"
			style={{ "--line-digits": String(view.digits) } as CSSProperties}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: built by diffHtml from escaped text only (highlightLines escapes every token).
			dangerouslySetInnerHTML={{ __html: view.html }}
		/>
	);
});

const UNTRACKED_TEXT = {
	too_large: "untrackedTooLarge",
	binary: "untrackedBinary",
	unreadable: "untrackedUnreadable",
	unknown: "untrackedUnknown",
} as const;

function FileRow({
	file,
	cwd,
	expanded,
	menuOpen,
}: {
	readonly file: ChangedFile;
	readonly cwd: string;
	readonly expanded: boolean;
	readonly menuOpen: boolean;
}) {
	const t = useT();
	const [directory, name] = splitPath(file.path);
	// The preview reads workspace-relative paths only.
	const inWorkspace = !/^([\\/]|[A-Za-z]:)/.test(file.path) && !file.path.startsWith("..");
	const menuKey = `file:${file.path}`;
	return (
		<li className={expanded ? "changes-file open" : "changes-file"} data-path={file.path}>
			<div className="changes-file-row">
				<button
					type="button"
					className="changes-file-toggle"
					aria-expanded={expanded}
					data-tooltip={file.path}
					onClick={() => toggleChangedFile(file.path)}
				>
					<FileBadge path={file.path} />
					<span className="changes-file-path">
						<span className="changes-file-dir">
							<bdi>{directory}</bdi>
						</span>
						<span className="changes-file-name">{name}</span>
					</span>
					<DiffStat additions={file.additions} deletions={file.deletions} />
				</button>
				<Tooltip content={t("openFile")}>
					<IconButton
						className="changes-file-action"
						icon="openExternal"
						iconSize="xs"
						aria-label={t("openFile")}
						disabled={!inWorkspace || !cwd}
						onClick={() => void openFile(cwd, file.path)}
					/>
				</Tooltip>
				<Popover
					className="changes-menu changes-file-menu"
					placement="bottom-end"
					open={menuOpen}
					closeOnEscape={false}
					onClose={() => setUi({ changesMenu: null })}
					content={
						<Menu role="menu">
							<MenuItem
								role="menuitem"
								onClick={() => {
									setUi({ changesMenu: null });
									void copyText(file.path);
								}}
							>
								{t("copyPath")}
							</MenuItem>
							<MenuItem
								role="menuitem"
								onClick={() => {
									setUi({ changesMenu: null });
									void copyText(file.patches.join("\n"));
								}}
							>
								{t("copyDiff")}
							</MenuItem>
						</Menu>
					}
				>
					<Tooltip content={t("moreActions")}>
						<IconButton
							className="changes-file-action"
							icon="more"
							iconSize="xs"
							aria-label={t("moreActions")}
							aria-haspopup="menu"
							aria-expanded={menuOpen}
							onClick={() => setUi({ changesMenu: menuOpen ? null : menuKey })}
						/>
					</Tooltip>
				</Popover>
			</div>
			{expanded ? (
				<>
					{file.patches.length ? <FileDiff file={file} /> : null}
					{file.untracked ? <p className="changes-untracked">{t(UNTRACKED_TEXT[file.untracked])}</p> : null}
				</>
			) : null}
		</li>
	);
}

function turnLabel(turn: TurnChanges, t: ReturnType<typeof useT>): string {
	return turn.latest ? t("lastTurn") : t("turnNumber", { count: turn.ordinal });
}

export function ChangesView({ hidden, embedded = false }: { readonly hidden: boolean; readonly embedded?: boolean }) {
	const t = useT();
	const items = useAppStore((state) => state.timelineItems);
	const cwd = useAppStore((state) => state.current?.cwd ?? "");
	const view = useAppStore((state) => state.preview.changes);
	const menu = useAppStore((state) => state.ui.changesMenu);
	const hasTabs = useAppStore((state) => state.preview.tabs.length > 0);
	const listRef = useRef<HTMLUListElement>(null);
	// Grouping walks the whole timeline; skip it while the view is not shown.
	const turns = useMemo(() => (hidden ? [] : collectTurnChanges(items, cwd)), [hidden, items, cwd]);
	const turn = turns.find((candidate) => candidate.turnId === view?.turnId) ?? turns.at(-1);
	const expanded = view?.turnId === turn?.turnId ? view?.expanded : undefined;

	// biome-ignore lint/correctness/useExhaustiveDependencies: focusSeq asks to scroll again to the same file.
	useLayoutEffect(() => {
		if (hidden || !view?.focus) return;
		const row = [...(listRef.current?.querySelectorAll<HTMLElement>(".changes-file") ?? [])].find(
			(element) => element.dataset.path === view.focus,
		);
		row?.scrollIntoView({ block: "start" });
	}, [hidden, view?.focus, view?.focusSeq]);

	const closeMenu = () => setUi({ changesMenu: null });
	return (
		<section className="changes-view" id="changesView" aria-label={t("turnChanges")} hidden={hidden}>
			{/* With no turn there is nothing to pick or act on; the body's empty state says so alone. */}
			<div className="changes-header" hidden={!turn}>
				<div className="changes-turn">
					<Popover
						className="changes-menu changes-turn-menu"
						open={menu === "turn"}
						closeOnEscape={false}
						onClose={closeMenu}
						content={
							<Menu role="menu">
								{[...turns].reverse().map((candidate) => (
									<MenuItem
										key={candidate.turnId}
										role="menuitemradio"
										aria-checked={candidate.turnId === turn?.turnId}
										trailing={<DiffStat additions={candidate.additions} deletions={candidate.deletions} />}
										onClick={() => {
											closeMenu();
											openTurnChanges(candidate.turnId);
										}}
									>
										{turnLabel(candidate, t)}
									</MenuItem>
								))}
							</Menu>
						}
					>
						<button
							type="button"
							className="changes-pill changes-turn-button"
							aria-haspopup="menu"
							aria-expanded={menu === "turn"}
							disabled={!turn}
							onClick={() => setUi({ changesMenu: menu === "turn" ? null : "turn" })}
						>
							<span>{turn ? turnLabel(turn, t) : ""}</span>
							<Icon name="chevronDown" size="xs" />
							{turn ? <DiffStat additions={turn.additions} deletions={turn.deletions} /> : null}
						</button>
					</Popover>
				</div>
				<div className="changes-pill changes-tools">
					<Popover
						className="changes-menu changes-more-menu"
						placement="bottom-end"
						open={menu === "more"}
						closeOnEscape={false}
						onClose={closeMenu}
						content={
							<Menu role="menu">
								<MenuItem
									role="menuitem"
									onClick={() => {
										closeMenu();
										if (turn) setChangedFilesExpanded(turn.files.map((file) => file.path));
									}}
								>
									{t("expandAllFiles")}
								</MenuItem>
								<MenuItem
									role="menuitem"
									onClick={() => {
										closeMenu();
										setChangedFilesExpanded([]);
									}}
								>
									{t("collapseAllFiles")}
								</MenuItem>
								<MenuItem
									role="menuitem"
									onClick={() => {
										closeMenu();
										if (turn) void copyText(turn.files.flatMap((file) => file.patches).join("\n"));
									}}
								>
									{t("copyDiff")}
								</MenuItem>
							</Menu>
						}
					>
						<Tooltip content={t("moreActions")}>
							<IconButton
								icon="more"
								iconSize="sm"
								aria-label={t("moreActions")}
								aria-haspopup="menu"
								aria-expanded={menu === "more"}
								disabled={!turn}
								onClick={() => setUi({ changesMenu: menu === "more" ? null : "more" })}
							/>
						</Tooltip>
					</Popover>
					<Tooltip content={t("showOpenFiles")}>
						<IconButton
							icon="fileSearch"
							iconSize="sm"
							aria-label={t("showOpenFiles")}
							disabled={!hasTabs}
							onClick={showPreviewFiles}
						/>
					</Tooltip>
					<Tooltip content={t("closePreview")}>
						<IconButton
							icon="panelRight"
							iconSize="sm"
							aria-label={t("closePreview")}
							hidden={embedded}
							onClick={() => setPreviewOpen(false)}
						/>
					</Tooltip>
				</div>
			</div>
			{turn ? (
				<ul className="changes-files" ref={listRef}>
					{turn.files.map((file) => (
						<FileRow
							key={file.path}
							file={file}
							cwd={cwd}
							expanded={Boolean(expanded?.has(file.path))}
							menuOpen={menu === `file:${file.path}`}
						/>
					))}
				</ul>
			) : (
				<div className="preview-message changes-empty">
					<Icon name="fileDiff" />
					{t("noTurnChanges")}
				</div>
			)}
		</section>
	);
}
