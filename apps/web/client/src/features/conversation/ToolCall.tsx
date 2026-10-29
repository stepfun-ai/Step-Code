import { type CSSProperties, memo, useId, useMemo, useState } from "react";
import { useT } from "../../i18n";
import { cx } from "../../lib/format";
import { escapeHtml } from "../../lib/markdown";
import { displayPath, parsedPatch } from "../../lib/turn-changes";
import { copyText } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { FileChange, ToolArgs, ToolTimelineItem } from "../../state/types";
import { DiffStat, Icon, type IconName, Tooltip, useCopiedFlag } from "../../ui";
import { openFile } from "../files/actions";
import { fileLanguage, highlightLines } from "../files/index";
import { openChildAgent, openWorkflowAgents } from "./actions";
import { SubagentLane } from "./SubagentLane";
import { type ToolKind, toolKind, toolLabel } from "./tool-presentation";

/** Lines of a file excerpt shown before the middle folds away behind a button. */
const HEAD_LINES = 14;
const TAIL_LINES = 3;

const KIND_ICON: Readonly<Record<ToolKind, IconName>> = {
	read: "fileText",
	write: "squarePen",
	edit: "squarePen",
	bash: "prompt",
	search: "fileSearch",
	list: "tree",
	other: "wrench",
};

const FILE_KINDS: ReadonlySet<ToolKind> = new Set(["read", "write", "edit"]);

/** `+12 -3` of an edit/write call, when its patch was recorded. */
export function toolDiffStat(change: FileChange | undefined): { additions: number; deletions: number } | null {
	if (!change?.patch) return null;
	const { additions, deletions } = parsedPatch(change.patch);
	return { additions, deletions };
}

/**
 * The path argument of a call when the preview can open it, and the shorter path
 * the row shows (relative to the session folder when it lies inside it).
 */
function callPath(args: ToolArgs | undefined, cwd: string): { shown: string; openable: string | null } {
	const path = args?.path;
	if (!path) return { shown: "", openable: null };
	// The preview reads a path relative to the session folder; anything else stays plain text.
	const outside = path.startsWith("/") || path.startsWith("~");
	return { shown: displayPath(path, cwd), openable: cwd && !outside ? path : null };
}

/**
 * A tool call in the stream. The collapsed row names the call — `读取 · src/a.ts`,
 * `运行命令 · npm run build` — and expanding it shows what the call did: the
 * command and its output, the file excerpt, or the recorded diff. A call that
 * started child agents links to their read-only transcripts.
 */
export const ToolRow = memo(function ToolRow({
	item,
	readOnly = false,
	onExpandedChange,
}: {
	readonly item: ToolTimelineItem;
	/** Inside a child agent's transcript, which links to no further children. */
	readonly readOnly?: boolean;
	/** Preserve the reader's disclosure choice when a singleton gains siblings. */
	readonly onExpandedChange?: (expanded: boolean) => void;
}) {
	const t = useT();
	const cwd = useAppStore((state) => state.current?.cwd ?? "");
	// A call still pending in a session that is no longer working never got its result (the turn
	// was stopped or the host restarted): it stops claiming to run.
	const idle = useAppStore((state) => {
		const status = state.current?.status;
		return status !== undefined && status !== "running" && status !== "waiting";
	});
	const stale = !readOnly && idle && item.state === "pending";
	const [open, setOpen] = useState(false);
	const [visited, setVisited] = useState(false);
	const detailsId = useId();
	const label = toolLabel(item, t);
	const output = item.outputDetail || item.outputSummary;
	const call = callPath(item.args, cwd);
	const shown = call.shown;
	// Only a file opens in the preview; a search or list path is usually a folder.
	const openable = FILE_KINDS.has(toolKind(item)) ? call.openable : null;
	const copyValue = toolKind(item) === "bash" ? (item.args?.command ?? "") : output;
	const card = toolKind(item) === "edit" || toolKind(item) === "write";
	if (!readOnly && item.toolName === "subagent" && item.subagentTasks?.length && item.state !== "failed") {
		return <SubagentLane item={item} />;
	}
	return (
		<div className={cx("tool-call", open && "open")} data-kind={toolKind(item)} data-tool-state={item.state}>
			{/* Not a button: the subject is a button of its own, and a button cannot hold one. The
			    toggle stretches under the whole row, so a click anywhere but the subject expands it. */}
			<div className={cx("tool-row", stale ? "stale" : item.state, open && "open")}>
				<button
					type="button"
					className="tool-toggle"
					aria-label={`${label} ${item.args?.command ?? shown}`.trim()}
					aria-expanded={open}
					aria-controls={detailsId}
					onClick={() => {
						setVisited(true);
						setOpen(!open);
						onExpandedChange?.(!open);
					}}
				></button>
				<span className="tool-heading">
					<span className="tool-glyph" aria-hidden="true">
						<Icon className="tool-kind-icon" name={KIND_ICON[toolKind(item)]} size="xs" />
					</span>
					<span className="tool-verb">
						{label}
						<span className="tool-pending" data-label={label} aria-hidden="true" />
					</span>
					<Icon className="tool-twisty" name="disclosure" size="xs" />
				</span>
				<span className="tool-detail">
					<span className="tool-dot" aria-hidden="true">
						·
					</span>
					{/* No "failed" tag: every failed verb already says so ("运行命令失败"), beside a red glyph,
					    so a failed call folded into a process group stays as quiet as its siblings. */}
					{stale ? <span className="tool-failed">{t("toolInterrupted")}</span> : null}
					<RowSubject item={item} path={shown} openable={openable} />
					{item.change?.patch ? <DiffStatRow item={item} /> : null}
				</span>
			</div>
			{!readOnly && (item.children?.length || item.workflowRun) ? <ChildAgentLinks item={item} /> : null}
			{!readOnly && item.toolName === "subagent" && item.state === "failed" && item.subagentTasks?.length ? (
				<SubagentLane item={item} />
			) : null}
			<div id={detailsId} className={cx("tool-disclosure", open && "expanded")} aria-hidden={!open} inert={!open}>
				<div className="tool-disclosure-body">
					{visited ? (
						<div className="tool-cx">
							{/* A command's input is the command itself, already printed in full on the card head. */}
							{toolKind(item) === "bash" ? null : (
								<details className="tool-cx-input">
									<summary>
										<Icon name="chevronRight" size="2xs" />
										{t("toolInput")}
										<code>{item.toolName}</code>
									</summary>
									<pre className="tool-cx-pre wrap">
										{item.inputDetail || item.inputSummary || t("toolNoInput")}
									</pre>
								</details>
							)}
							{card ? (
								<ChangeCard item={item} path={shown} openable={openable} />
							) : (
								<ToolCard item={item} path={shown} openable={openable} copyValue={copyValue} />
							)}
							<div className={cx("tool-cx-status", item.state)}>
								{item.state === "completed" ? <Icon name="check" size="2xs" /> : null}
								{t(`toolStatus.${item.state}`)}
							</div>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
});

/** Links from a subagent or workflow call to the transcripts of the agents it started. */
function ChildAgentLinks({ item }: { readonly item: ToolTimelineItem }) {
	const t = useT();
	const workflowRun = item.workflowRun;
	return (
		<div className="tool-children">
			{workflowRun ? (
				<button
					type="button"
					className="tool-child-link"
					data-workflow-run={workflowRun}
					onClick={() => openWorkflowAgents(workflowRun, `workflow · ${workflowRun}`)}
				>
					<Icon name="layers" size="xs" />
					<span>{t("childAgentWorkflowOpen")}</span>
				</button>
			) : null}
			{(item.subagentTasks?.length ? [] : item.children)?.map((child) => (
				<button
					key={child.sessionId}
					type="button"
					className="tool-child-link"
					data-child-session-id={child.sessionId}
					onClick={() => openChildAgent(child.sessionId, child.label || t("childAgent"))}
				>
					<Icon name="orbit" size="xs" />
					<span>{child.label || t("childAgentOpen")}</span>
				</button>
			))}
		</div>
	);
}

function DiffStatRow({ item }: { readonly item: ToolTimelineItem }) {
	const stat = toolDiffStat(item.change);
	return stat ? <DiffStat className="tool-stat" additions={stat.additions} deletions={stat.deletions} /> : null;
}

/** The one line after the verb: a path, a command, a pattern, or the call's summary. */
function RowSubject({
	item,
	path,
	openable,
}: {
	readonly item: ToolTimelineItem;
	readonly path: string;
	readonly openable: string | null;
}) {
	const t = useT();
	const cwd = useAppStore((state) => state.current?.cwd ?? "");
	const tool = toolKind(item);
	const text =
		tool === "bash"
			? (item.args?.command ?? "").split("\n")[0]
			: tool === "list"
				? path || "."
				: path || item.inputSummary;
	if (openable) {
		return (
			<button type="button" className="tool-subject tool-subject-link" onClick={() => void openFile(cwd, openable)}>
				{text}
			</button>
		);
	}
	return <span className="tool-subject">{text || t("toolNoInput")}</span>;
}

/** Header of an expanded card: a state dot, the command or path, then its actions. */
function CardHead({
	item,
	text,
	copied,
	copyLabel,
	onCopy,
	openable,
	wrap,
	onWrap,
}: {
	readonly item: ToolTimelineItem;
	readonly text: string;
	readonly copied: boolean;
	readonly copyLabel: string;
	readonly onCopy: () => void;
	readonly openable: string | null;
	/** Present when the body is text that can wrap; a diff keeps its columns. */
	readonly wrap?: boolean;
	readonly onWrap?: () => void;
}) {
	const t = useT();
	const cwd = useAppStore((state) => state.current?.cwd ?? "");
	return (
		<div className="tool-cx-head">
			<span className={cx("tool-cx-state", item.state)} aria-hidden="true" />
			<code className="tool-cx-summary">{text}</code>
			{openable ? (
				<Tooltip content={t("toolOpenFile")}>
					<button
						type="button"
						className="tool-cx-action"
						aria-label={t("toolOpenFile")}
						onClick={() => void openFile(cwd, openable)}
					>
						<Icon name="open" size="xs" />
					</button>
				</Tooltip>
			) : null}
			{onWrap ? (
				<Tooltip content={t("toolWrapLines")}>
					<button
						type="button"
						className={cx("tool-cx-action", wrap && "active")}
						aria-label={t("toolWrapLines")}
						aria-pressed={wrap}
						onClick={onWrap}
					>
						<Icon name="wrap" size="xs" />
					</button>
				</Tooltip>
			) : null}
			<Tooltip content={copyLabel}>
				<button
					type="button"
					className="tool-cx-action"
					aria-label={copyLabel}
					data-copied={copied || undefined}
					onClick={onCopy}
				>
					<Icon name={copied ? "check" : "copy"} size="xs" />
				</button>
			</Tooltip>
		</div>
	);
}

/** A command's or a tool's card: the call on the header line, then its output. */
function ToolCard({
	item,
	path,
	openable,
	copyValue,
}: {
	readonly item: ToolTimelineItem;
	readonly path: string;
	readonly openable: string | null;
	readonly copyValue: string;
}) {
	const t = useT();
	const [copied, flashCopied] = useCopiedFlag();
	const [wrap, setWrap] = useState(false);
	const copy = async () => {
		if (await copyText(copyValue, null)) flashCopied();
	};
	const command = toolKind(item) === "bash";
	const head = command ? item.args?.command || item.inputSummary : path || item.inputSummary;
	return (
		<>
			<CardHead
				item={item}
				text={head || t("toolNoInput")}
				copied={copied}
				copyLabel={command ? t("copy") : t("toolCopyOutput")}
				onCopy={() => void copy()}
				openable={openable}
				wrap={wrap}
				onWrap={() => setWrap((value) => !value)}
			/>
			<div className="tool-cx-section">{t("toolOutput")}</div>
			<OutputCard item={item} path={path} text={item.outputDetail || item.outputSummary} wrap={wrap} />
		</>
	);
}

/** Output text, highlighted when it is a file excerpt, with a long middle folded away. */
function OutputCard({
	item,
	path,
	text,
	wrap,
}: {
	readonly item: ToolTimelineItem;
	readonly path: string;
	readonly text: string;
	readonly wrap: boolean;
}) {
	const t = useT();
	const [uncollapsed, setUncollapsed] = useState(false);
	const highlighted = useMemo(
		() => (toolKind(item) === "read" && path ? highlightLines(text, fileLanguage(path)) : null),
		[item, path, text],
	);
	if (!text) {
		return <p className="tool-cx-empty">{item.state === "pending" ? t("toolRunning") : t("toolNoOutput")}</p>;
	}
	if (!highlighted) {
		return <pre className={cx("tool-cx-pre", wrap && "wrap")}>{text}</pre>;
	}
	// A trailing newline is the end of the last line, not one more line.
	const lines = highlighted.length > 1 && highlighted.at(-1) === "" ? highlighted.slice(0, -1) : highlighted;
	const folded = lines.length > HEAD_LINES + TAIL_LINES + 2 && !uncollapsed;
	// A read from `offset` numbers its lines from there (1-based), as the file does.
	const first = Math.max(0, (item.args?.offset ?? 1) - 1);
	const rows = (from: number, to?: number) =>
		lines
			.slice(from, to)
			.map((line) => `<div class="code-line">${line || " "}</div>`)
			.join("");
	return (
		<div
			className={cx("tool-cx-code", wrap && "wrap")}
			style={
				{ "--line-digits": String(first + lines.length).length, counterReset: `line ${first}` } as CSSProperties
			}
		>
			{/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlightLines escapes every token. */}
			<div dangerouslySetInnerHTML={{ __html: rows(0, folded ? HEAD_LINES : undefined) }} />
			{folded ? (
				<>
					<button type="button" className="tool-cx-more" onClick={() => setUncollapsed(true)}>
						{t("toolMoreLines", { count: lines.length - HEAD_LINES - TAIL_LINES })}
					</button>
					{/* The tail keeps the file's real line numbers. */}
					<div
						style={{ counterReset: `line ${first + lines.length - TAIL_LINES}` }}
						// biome-ignore lint/security/noDangerouslySetInnerHtml: highlightLines escapes every token.
						dangerouslySetInnerHTML={{ __html: rows(-TAIL_LINES) }}
					/>
				</>
			) : null}
		</div>
	);
}

/** An edit or write: the recorded patch as a diff, or the arguments when none was recorded. */
function ChangeCard({
	item,
	path,
	openable,
}: {
	readonly item: ToolTimelineItem;
	readonly path: string;
	readonly openable: string | null;
}) {
	const t = useT();
	const [copied, flashCopied] = useCopiedFlag();
	const patch = item.change?.patch;
	const diff = useMemo(() => (patch ? diffRows(patch, path) : null), [patch, path]);
	const copy = async () => {
		if (await copyText(patch ?? item.inputDetail ?? "", null)) flashCopied();
	};
	return (
		<>
			<CardHead
				item={item}
				text={path || item.inputSummary}
				copied={copied}
				copyLabel={t("toolCopyOutput")}
				onCopy={() => void copy()}
				openable={openable}
			/>
			{diff ? (
				<div
					className="tool-cx-diff"
					style={{ "--line-digits": String(diff.digits) } as CSSProperties}
					// biome-ignore lint/security/noDangerouslySetInnerHtml: built by diffRows from escaped text only.
					dangerouslySetInnerHTML={{ __html: diff.html }}
				/>
			) : (
				<pre className="tool-cx-pre">{item.inputDetail || item.inputSummary || t("toolNoInput")}</pre>
			)}
			{item.outputDetail || item.outputSummary ? (
				<>
					<div className="tool-cx-section">{t("toolOutput")}</div>
					<pre className="tool-cx-pre wrap">{item.outputDetail || item.outputSummary}</pre>
				</>
			) : null}
		</>
	);
}

/** `.tool-cx-diff-line` rows of a unified patch, each text line highlighted for the file's language. */
function diffRows(patch: string, path: string): { html: string; digits: number } {
	const rows = parsedPatch(patch).lines;
	const highlighted = highlightLines(
		rows.map((row) => (row.kind === "hunk" ? "" : row.text)).join("\n"),
		fileLanguage(path),
	);
	let digits = 1;
	const html = rows
		.map((row, index) => {
			if (row.kind === "hunk") return `<div class="tool-cx-diff-line hunk">${escapeHtml(row.text) || "⋯"}</div>`;
			digits = Math.max(digits, String(row.number ?? "").length);
			return `<div class="tool-cx-diff-line ${row.kind}"><span class="tool-cx-diff-number">${row.number ?? ""}</span><span class="tool-cx-diff-code">${highlighted[index] || " "}</span></div>`;
		})
		.join("");
	return { html, digits };
}
