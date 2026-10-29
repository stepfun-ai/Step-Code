import { memo, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { type AttachedFile, FILE_MARKER, markAttachedFiles, splitAttachedFiles } from "../../lib/attached-files";
import { formatBytes, formatTokens } from "../../lib/format";
import {
	escapeHtml,
	pluginInstallInvocation,
	renderMarkdown,
	type SessionContextQuote,
	sessionContextOf,
	skillInvocation,
	ultraloopInvocation,
} from "../../lib/markdown";
import { copyText } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import type { MessageTimelineItem } from "../../state/types";
import { Icon, MarkdownView } from "../../ui";
import { commandLeadIcon } from "../composer";
import { openFileReference } from "../files/actions";
import { highlightFence } from "../files/index";
import { forkAtEntry } from "./actions";
import { CopyAction } from "./CopyAction";
import { openFeedback, type Sentiment } from "./feedback";
import { clockTime } from "./message-meta";
import { useFadeIn, useSmoothText } from "./streaming";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { MessageAttachments } from "./TurnArtifacts";
import type { TurnArtifact } from "./turn-artifacts";

/** Same markup as the composer's chip (`prompt-editor.ts` `createChip`), so a sent message reads like its draft. */
function fileChipHtml(file: AttachedFile | undefined): string {
	if (!file) return "";
	const title = escapeHtml(`${file.path} · ${formatBytes(file.bytes)}`);
	return `<span class="message-file" title="${title}"><svg class="icon icon--xs" aria-hidden="true"><use href="#i-fileText"></use></svg><span>${escapeHtml(file.name)}</span></span>`;
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
	/**
	 * Model id shown with the sent-message timestamp. The transcript records no
	 * model per message, so the caller passes the one the session ran on.
	 */
	readonly model?: string;
	/**
	 * Present only on the latest user message: the entry a rewrite forks to
	 * ("" forks from the head). Its presence makes the bubble editable in place.
	 * A row without an entry id (the echo of a prompt still being sent) has no
	 * recorded message to rewrite, so it offers no action even when it is latest.
	 */
	readonly rewritableBefore?: string;
}) {
	const t = useT();
	const role = item.role === "user" ? "user" : "assistant";
	const currentCwd = useAppStore((state) => state.current?.cwd ?? "");
	const cwd = fileCwd ?? currentCwd;
	const live = item.itemId.startsWith("message-live");
	const codeLabel = t("code");
	const copyLabel = t("copy");
	const tableLabel = t("markdownTable");
	const bodyRef = useRef<HTMLDivElement>(null);
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
	// Memoised: a streaming turn re-renders the timeline per frame, and parsing every earlier message each time made long sessions crawl.
	const files = pendingFiles ?? attached.files;
	const html = useMemo(() => {
		if (!files.length)
			return renderMarkdown(
				content,
				{ code: codeLabel, copy: copyLabel, table: tableLabel },
				{ localFiles: role === "assistant" && Boolean(cwd), highlightCode: highlightFence },
			);
		return renderMarkdown(
			markAttachedFiles(content, files),
			{ code: codeLabel, copy: copyLabel, table: tableLabel },
			{ highlightCode: highlightFence },
		).replace(FILE_MARKER, (_match, index: string) => fileChipHtml(files[Number(index)]));
	}, [content, files, codeLabel, copyLabel, tableLabel, role, cwd]);
	/*
	 * An invoked message carries its badge inline at the head of the markdown's
	 * first line — prepended into the rendered html, so the command chip and
	 * the prompt share one bubble with native typography.
	 */
	const badgeLabel = command ? `/${command.name}` : (skill?.name ?? pluginInstall?.name ?? t("modeUltraloop"));
	const badgeIcon = command ? commandLeadIcon(command.name) : skill ? "wrench" : ultraloop ? "orbit" : "puzzle";
	const badgeKind = command ? "command" : skill ? "skill" : ultraloop ? "ultraloop" : "plugin";
	const badgeHtml = `<span class="message-skill message-skill--${badgeKind}" title="${escapeHtml(badgeLabel)}"><span class="tool-glyph" aria-hidden="true"><svg class="icon icon--xs tool-kind-icon" aria-hidden="true"><use href="#i-${badgeIcon}"></use></svg></span>${escapeHtml(badgeLabel)}</span>`;
	// A bare prompt command (no arguments) is the badge alone, like an echoed kernel command.
	const invokedHtml =
		command && !html
			? badgeHtml
			: (skill || ultraloop || pluginInstall || command) && html
				? `${badgeHtml}${html}`
				: html;
	useFadeIn(bodyRef, html, live);
	if (item.error) return <MessageError entryId={item.entryId} error={item.error} />;
	// The live turn before its first text (reasoning, or waiting on the first token).
	if (role === "assistant" && !content) return <ThinkingIndicator />;
	/*
	 * A command-invoking message carries its badge inside the bubble, inline
	 * before the text — the command and the prompt share one bubble, exactly
	 * like the composer showed them.
	 */
	return (
		<article className={`message ${role}`} data-content={item.content || ""} data-entry-id={item.entryId}>
			{/* A user message can be images only; it still opens a turn, so it gets a row. */}
			{images.length ? <MessageImages images={images} /> : null}
			{content || command ? (
				<MarkdownView
					ref={bodyRef}
					className="message-body"
					html={invokedHtml}
					onCopyCode={(code) => copyText(code, null)}
					copiedLabel={t("copied")}
					onFileReference={(path) => void openFileReference(cwd, path)}
				/>
			) : null}
			{attachments?.length ? <MessageAttachments artifacts={attachments} cwd={cwd} /> : null}
			{quoted ? <QuotedContext quote={quoted.quote} /> : null}
			{role === "user" && item.content ? (
				<div className="prompt-actions">
					{/* A prompt command copies the line that runs it again, not just its arguments. */}
					<CopyAction value={command ? messageText : content} />
					{rewritableBefore !== undefined && item.entryId ? (
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

/**
 * What a message was and when: the model and the clock time (`14:05`), as plain
 * text with no label. A sent message shows it under its bubble; a reply shows it
 * once, on the row under the turn that settled. An entry without a timestamp (an
 * optimistic pending bubble) shows nothing.
 */
function MessageMeta({ timestamp }: { readonly timestamp: string }) {
	return (
		<span className="message-meta">
			<time className="message-meta-time" dateTime={timestamp}>
				{clockTime(timestamp)}
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
function MessageError({ entryId, error }: { readonly entryId?: string; readonly error: string }) {
	const t = useT();
	const detail = errorDetail(error);
	const parts = detail.message.split(/(https?:\/\/[^\s"'<>)]*[^\s"'<>),.;:!?])/g);
	return (
		<article className="message assistant message-error" role="alert" data-entry-id={entryId}>
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
	aborted = false,
}: {
	readonly messages: readonly MessageTimelineItem[];
	/** Model shown with the turn's time; the transcript records none per message. */
	readonly model?: string;
	/** The turn was stopped by the user: no finished reply to credit. */
	readonly aborted?: boolean;
}) {
	const t = useT();
	const [vote, setVote] = useState<Sentiment | null>(null);
	const tokens = messages.reduce((sum, item) => sum + (item.usage ? item.usage.input + item.usage.output : 0), 0);
	const content = messages
		.filter((item) => !item.error && item.content)
		.map((item) => item.content)
		.join("\n\n");
	const last = messages.at(-1);
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
			{/* The model and clock time belong to the turn that settled here, not to
			    every step of it: only this row carries them. */}
			{/* Only the clock, and only on hover: the model name is noise here. */}
			{last?.timestamp && !aborted ? <MessageMeta timestamp={last.timestamp} /> : null}
		</div>
	);
}
