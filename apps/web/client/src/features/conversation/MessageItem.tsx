import { memo, useCallback, useMemo, useState } from "react";
import { useMarkdownLabels, useT } from "../../i18n";
import { type AttachedFile, markAttachedFiles, splitAttachedFiles } from "../../lib/attached-files";
import { formatBytes, formatTokens } from "../../lib/format";
import {
	pluginInstallInvocation,
	type SessionContextQuote,
	sessionContextOf,
	skillInvocation,
	ultraloopInvocation,
} from "../../lib/markdown";
import { copyText } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import type { MessageTimelineItem } from "../../state/types";
import { Icon, type IconName, MarkdownView } from "../../ui";
import { commandLeadIcon } from "../composer";
import { openFileReference } from "../files/actions";
import { forkAtEntry } from "./actions";
import { CopyAction } from "./CopyAction";
import { openFeedback, type Sentiment } from "./feedback";
import { fullDateTime } from "./message-meta";
import { useSmoothText } from "./streaming";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { MessageAttachments } from "./TurnArtifacts";
import type { TurnArtifact } from "./turn-artifacts";

/** Same markup as the composer's chip (`prompt-editor.ts` `createChip`), so a sent message reads like its draft. */
function MessageFileChip({ file }: { readonly file: AttachedFile | undefined }) {
	if (!file) return null;
	return (
		<span className="message-file" title={`${file.path} · ${formatBytes(file.bytes)}`}>
			<Icon name="fileText" size="xs" />
			<span>{file.name}</span>
		</span>
	);
}

/** The command, skill, plugin or ultraloop badge that leads an invoking message's first line. */
function InvocationBadge({
	kind,
	icon,
	label,
}: {
	readonly kind: string;
	readonly icon: IconName;
	readonly label: string;
}) {
	return (
		<span className={`message-skill message-skill--${kind}`} title={label}>
			<span className="tool-glyph" aria-hidden="true">
				<Icon name={icon} size="xs" className="tool-kind-icon" />
			</span>
			{label}
		</span>
	);
}

/** `/code-review 123` -> the command name and what followed it; null when the line is not a command. */
function promptCommandLine(text: string): { readonly name: string; readonly args: string } | null {
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
	return match ? { name: match[1], args: match[2]?.trim() ?? "" } : null;
}

/**
 * One chat message (legacy `renderTimeline` message branch, app.js 2253-2261).
 * `data-content` and `data-entry-id` are kept from the legacy markup.
 */
export const MessageItem = memo(function MessageItem({
	item,
	files: pendingFiles,
	attachments,
	fileCwd,
	rewritableBefore,
	inlineTimestamp = false,
}: {
	readonly item: MessageTimelineItem;
	/** The pending bubble's files: the host has not echoed the message (and its file blocks) yet. */
	readonly files?: readonly AttachedFile[];
	/**
	 * The turn's deliverables, attached under this bubble when it is the reply
	 * that closed the turn: the answer hands its files over where it ends.
	 */
	readonly attachments?: readonly TurnArtifact[];
	/** Read-only child transcripts resolve references against their own workspace. */
	readonly fileCwd?: string;
	/** Legacy session-model hint; message timestamps use only recorded instants. */
	readonly model?: string;
	/**
	 * Present only on the latest user message: the entry a rewrite forks to
	 * ("" forks from the head). Its presence makes the bubble editable in place.
	 * A row without an entry id (the echo of a prompt still being sent) has no
	 * recorded message to rewrite, so it offers no action even when it is latest.
	 */
	readonly rewritableBefore?: string;
	/** Only the final reply in a timestamp-only (error or read-only child) turn renders inline metadata. */
	readonly inlineTimestamp?: boolean;
}) {
	const t = useT();
	const role = item.role === "user" ? "user" : "assistant";
	const currentCwd = useAppStore((state) => state.current?.cwd ?? "");
	const cwd = fileCwd ?? currentCwd;
	const live = item.itemId.startsWith("message-live");
	const labels = useMarkdownLabels();
	// Pasted or dropped files arrive as blocks after the user's text; the bubble shows them as inline chips where the user put them.
	const attached = useMemo(
		() => (role === "user" ? splitAttachedFiles(item.content) : { text: item.content, files: [] }),
		[role, item.content],
	);
	// A quoted other-session context rides at the tail; peel it before any invocation match.
	const quoted = role === "user" ? sessionContextOf(attached.text) : null;
	const messageText = quoted ? quoted.body : attached.text;
	/** A prompt command: the line the user typed stands in for the template the kernel expanded. */
	const command = role === "user" && item.promptCommand ? promptCommandLine(messageText) : null;
	const skill = role === "user" && !command ? skillInvocation(messageText) : null;
	/** The install command a plugin pick chip sent; badge only, no body change. */
	const pluginInstall = role === "user" && !command && !skill ? pluginInstallInvocation(messageText) : null;
	/** The ultraloop keyword form rides the message as ordinary text; its badge mirrors the skill one. */
	const ultraloop = role === "user" && !command && !skill && !pluginInstall ? ultraloopInvocation(messageText) : null;
	const content = useSmoothText(
		command ? command.args : skill || ultraloop ? (skill?.request ?? ultraloop?.request ?? "") : messageText,
		live,
	);
	const images = role === "user" ? (item.images ?? []) : [];
	const files = pendingFiles ?? attached.files;
	// Memoised so the renderer, itself memoised on its props, does not reparse settled messages while a turn streams.
	const source = useMemo(() => (files.length ? markAttachedFiles(content, files) : content), [content, files]);
	const fileNames = useMemo(() => files.map((file) => file.name), [files]);
	const renderFile = useCallback((index: number) => <MessageFileChip file={files[index]} />, [files]);
	const copyCode = useCallback((code: string) => copyText(code, null), []);
	const openReference = useCallback((path: string) => void openFileReference(cwd, path), [cwd]);
	/*
	 * An invoked message carries its badge inline at the head of the markdown's
	 * first line, so the command chip and the prompt share one bubble with
	 * native typography.
	 */
	const badge =
		command || skill || ultraloop || pluginInstall ? (
			<InvocationBadge
				kind={command ? "command" : skill ? "skill" : ultraloop ? "ultraloop" : "plugin"}
				icon={command ? commandLeadIcon(command.name) : skill ? "wrench" : ultraloop ? "orbit" : "puzzle"}
				label={command ? `/${command.name}` : (skill?.name ?? pluginInstall?.name ?? t("modeUltraloop"))}
			/>
		) : null;
	if (item.error) return <MessageError item={item} inlineTimestamp={inlineTimestamp} />;
	// The live turn before its first text (reasoning, or waiting on the first token).
	if (role === "assistant" && !content) return <ThinkingIndicator />;
	return (
		<article className={`message ${role}`} data-content={item.content || ""} data-entry-id={item.entryId}>
			{/* A user message can be images only; it still opens a turn, so it gets a row. */}
			{images.length ? <MessageImages images={images} /> : null}
			{content || command ? (
				<MarkdownView
					className={badge ? "message-body message-body--invoked" : "message-body"}
					source={source}
					labels={labels}
					streaming={live}
					// A bare prompt command (no arguments) is the badge alone, like an echoed kernel command.
					lead={badge}
					localFiles={!files.length && role === "assistant" && Boolean(cwd)}
					fileNames={fileNames}
					renderFile={renderFile}
					onCopyCode={copyCode}
					copiedLabel={t("copied")}
					onFileReference={openReference}
				/>
			) : null}
			{attachments?.length ? <MessageAttachments artifacts={attachments} cwd={cwd} /> : null}
			{quoted ? <QuotedContext quote={quoted.quote} /> : null}
			{role === "user" ? (
				<div className="prompt-actions">
					<MessageMeta item={item} />
					{/* A prompt command copies the line that runs it again, not just its arguments. */}
					{item.content ? <CopyAction value={command ? messageText : content} /> : null}
					{item.content && rewritableBefore !== undefined && item.entryId ? (
						<button
							type="button"
							className="message-action"
							title={t("promptRewrite")}
							aria-label={t("promptRewrite")}
							onClick={() =>
								setUi({
									editingPrompt: {
										entryId: item.entryId ?? "",
										before: rewritableBefore || undefined,
										text: item.content,
									},
								})
							}
						>
							<Icon name="squarePen" size="xs" />
						</button>
					) : null}
				</div>
			) : null}
			{role === "assistant" && inlineTimestamp ? <MessageMeta item={item} /> : null}
		</article>
	);
});

/**
 * The quoted other-session context of a sent message: one collapsed row naming
 * the source session, expanded on demand to the capped transcript.
 */
function QuotedContext({ quote }: { readonly quote: SessionContextQuote }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const label = t("quotedSessionContextTitle", { title: quote.title });
	return (
		<div className="message-quote">
			<button
				type="button"
				className="message-quote-toggle"
				aria-expanded={open}
				aria-label={t("quotedSessionContext")}
				title={label}
				onClick={() => setOpen((value) => !value)}
			>
				<Icon name="conversation" size="2xs" />
				<span className="message-quote-title">{label}</span>
			</button>
			{open ? <pre className="message-quote-body">{quote.transcript}</pre> : null}
		</div>
	);
}

/** Only recorded instants are displayed; live and optimistic rows never acquire a browser time. */
function MessageMeta({ item }: { readonly item: MessageTimelineItem }) {
	if (!item.entryId || item.itemId.startsWith("message-live")) return null;
	const label = fullDateTime(item.timestamp);
	if (!label) return null;
	return (
		<span className="message-meta">
			{/* Timestamp-only replies have no actions; focus still needs to reveal recorded metadata. */}
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus reveals otherwise hover-only recorded metadata. */}
			<time className="message-meta-time" dateTime={item.timestamp} tabIndex={0}>
				{label}
			</time>
		</span>
	);
}

/** A user message's images as thumbnails; clicking one opens `#imagePreview`. */
function MessageImages({ images }: { readonly images: readonly string[] }) {
	const t = useT();
	return (
		<div className="message-images">
			{images.map((src, index) => {
				const name = t("imageNumbered", { index: index + 1 });
				return (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: a message's images never reorder.
						key={index}
						type="button"
						className="message-image"
						aria-label={t("previewImageNamed", { name })}
						onClick={() => setUi({ imagePreview: { src, name } })}
					>
						<img src={src} alt="" />
					</button>
				);
			})}
		</div>
	);
}

/** `403: {"message": "..."}` -> the status and the provider's message; anything else unchanged. */
function errorDetail(error: string): { readonly status: string; readonly message: string } {
	const match = /^(\d{3}):\s*(\{[\s\S]*\})\s*$/.exec(error);
	if (!match) return { status: "", message: error };
	try {
		const body = JSON.parse(match[2]) as { message?: unknown; error?: { message?: unknown } };
		const message = body.message ?? body.error?.message;
		return { status: match[1], message: typeof message === "string" ? message : error };
	} catch {
		return { status: "", message: error };
	}
}

/** A failed model request: the provider's message, with any URL in it as a link (e.g. account verification). */
function MessageError({
	item,
	inlineTimestamp,
}: {
	readonly item: MessageTimelineItem;
	readonly inlineTimestamp: boolean;
}) {
	const t = useT();
	const detail = errorDetail(item.error ?? "");
	const parts = detail.message.split(/(https?:\/\/[^\s"'<>)]*[^\s"'<>),.;:!?])/g);
	return (
		<article className="message assistant message-error" role="alert" data-entry-id={item.entryId}>
			<div className="message-error-title">
				{t("modelRequestFailed")}
				{detail.status ? <span className="message-error-status">{detail.status}</span> : null}
			</div>
			<p className="message-error-text">
				{parts.map((part, index) =>
					index % 2 ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string.
						<a key={index} href={part} target="_blank" rel="noreferrer">
							{part}
						</a>
					) : (
						part
					),
				)}
			</p>
			{inlineTimestamp ? <MessageMeta item={item} /> : null}
		</article>
	);
}

/**
 * The row under an assistant turn: copy, vote, fork, then what the turn cost and
 * when it happened. The stream mounts it only after the entire turn settles.
 *
 * Voting opens the feedback dialog rather than firing a silent request — a
 * thumbs-down with no detail is much less useful than one with a topic.
 */
export function MessageActions({
	messages,
	timestampItem,
}: {
	readonly messages: readonly MessageTimelineItem[];
	/** The last recorded reply's timestamp, even when processes separate it from this toolbar. */
	readonly timestampItem?: MessageTimelineItem;
}) {
	const t = useT();
	const [vote, setVote] = useState<Sentiment | null>(null);
	const tokens = messages.reduce((sum, item) => sum + (item.usage ? item.usage.input + item.usage.output : 0), 0);
	const content = messages
		.filter((item) => !item.error && item.content)
		.map((item) => item.content)
		.join("\n\n");
	const entryId = messages.reduce<string | undefined>((previous, item) => item.entryId ?? previous, undefined);
	const onVote = (sentiment: Sentiment) => {
		// One vote visible at a time; clicking the active one clears it.
		setVote((already) => (already === sentiment ? null : sentiment));
		openFeedback(sentiment);
	};
	return (
		<div className="message-actions turn-actions">
			<CopyAction value={content} className="message-action copy-message" />
			<button
				className="message-action vote-up"
				type="button"
				aria-pressed={vote === "up"}
				title={t("feedbackGood")}
				aria-label={t("feedbackGood")}
				onClick={() => onVote("up")}
			>
				<Icon name="thumbsUp" size="sm" />
			</button>
			<button
				className="message-action vote-down"
				type="button"
				aria-pressed={vote === "down"}
				title={t("feedbackBad")}
				aria-label={t("feedbackBad")}
				onClick={() => onVote("down")}
			>
				<Icon name="thumbsDown" size="sm" />
			</button>
			<button
				className="message-action fork-message"
				type="button"
				title={t("forkHere")}
				aria-label={t("forkHere")}
				onClick={() => void forkAtEntry(entryId)}
			>
				<Icon name="fork" size="sm" />
			</button>
			{tokens ? (
				<span className="message-usage">
					<Icon name="gauge" size="xs" />
					{`${t("usage")} ${formatTokens(tokens)} tok`}
				</span>
			) : null}
			{timestampItem ? <MessageMeta item={timestampItem} /> : null}
		</div>
	);
}
