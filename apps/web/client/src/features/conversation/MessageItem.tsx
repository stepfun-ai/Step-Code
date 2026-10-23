import { memo, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { type AttachedFile, FILE_MARKER, markAttachedFiles, splitAttachedFiles } from "../../lib/attached-files";
import { formatBytes, formatTokens } from "../../lib/format";
import {
	escapeHtml,
	pluginInstallInvocation,
	renderMarkdown,
	skillInvocation,
	ultraloopInvocation,
} from "../../lib/markdown";
import { copyText } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import type { MessageTimelineItem } from "../../state/types";
import { Icon, LEGACY_ICONS, MarkdownView } from "../../ui";
import { openFileReference } from "../files/actions";
import { highlightFence } from "../files/index";
import { forkAtEntry } from "./actions";
import { openFeedback, type Sentiment } from "./feedback";
import { clockTime } from "./message-meta";
import { useFadeIn, useSmoothText } from "./streaming";
import { ThinkingIndicator } from "./ThinkingIndicator";

/** Same markup as the composer's chip (`prompt-editor.ts` `createChip`), so a sent message reads like its draft. */
function fileChipHtml(file: AttachedFile | undefined): string {
	if (!file) return "";
	const title = escapeHtml(`${file.path} · ${formatBytes(file.bytes)}`);
	return `<span class="message-file" title="${title}"><svg class="icon icon--xs" aria-hidden="true"><use href="#i-fileText"></use></svg><span>${escapeHtml(file.name)}</span></span>`;
}

/**
 * One chat message (legacy `renderTimeline` message branch, app.js 2253-2261).
 * `data-content` and `data-entry-id` are kept from the legacy markup.
 */
export const MessageItem = memo(function MessageItem({
	item,
	files: pendingFiles,
	fileCwd,
	model,
}: {
	readonly item: MessageTimelineItem;
	/** The pending bubble's files: the host has not echoed the message (and its file blocks) yet. */
	readonly files?: readonly AttachedFile[];
	/** Read-only child transcripts resolve references against their own workspace. */
	readonly fileCwd?: string;
	/**
	 * Model id shown with the sent-message timestamp. The transcript records no
	 * model per message, so the caller passes the one the session ran on.
	 */
	readonly model?: string;
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
	const skill = role === "user" ? skillInvocation(attached.text) : null;
	/** The install command a plugin pick chip sent; badge only, no body change. */
	const pluginInstall = role === "user" && !skill ? pluginInstallInvocation(attached.text) : null;
	/** The ultraloop keyword form rides the message as ordinary text; its badge mirrors the skill one. */
	const ultraloop = role === "user" && !skill && !pluginInstall ? ultraloopInvocation(attached.text) : null;
	const content = useSmoothText(
		skill || ultraloop ? (skill?.request ?? ultraloop?.request ?? "") : attached.text,
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
	useFadeIn(bodyRef, html, live);
	if (item.error) return <MessageError entryId={item.entryId} error={item.error} />;
	// The live turn before its first text (reasoning, or waiting on the first token).
	if (role === "assistant" && !content) return <ThinkingIndicator />;
	/*
	 * A command-invoking message carries its badge inside the bubble, inline
	 * before the text — the command and the prompt share one bubble, exactly
	 * like the composer showed them.
	 */
	const invoked = Boolean(skill || ultraloop || pluginInstall);
	return (
		<article className={`message ${role}`} data-content={item.content || ""} data-entry-id={item.entryId}>
			{/* A user message can be images only; it still opens a turn, so it gets a row. */}
			{images.length ? <MessageImages images={images} /> : null}
			{content ? (
				invoked ? (
					<div className="message-body message-body--invoked">
						{skill ? (
							<span className="message-skill message-skill--skill" title={skill.name}>
								<Icon name="wrench" size="xs" />
								{skill.name}
							</span>
						) : null}
						{ultraloop ? (
							<span className="message-skill message-skill--ultraloop">
								<Icon name="orbit" size="xs" />
								{t("modeUltraloop")}
							</span>
						) : null}
						{pluginInstall ? (
							<span className="message-skill message-skill--plugin" title={pluginInstall.name}>
								<Icon name="puzzle" size="xs" />
								{pluginInstall.name}
							</span>
						) : null}
						<MarkdownView
							ref={bodyRef}
							className="message-md"
							html={html}
							onCopyCode={(code) => void copyText(code)}
							onFileReference={(path) => void openFileReference(cwd, path)}
						/>
					</div>
				) : (
					<MarkdownView
						ref={bodyRef}
						className="message-body"
						html={html}
						onCopyCode={(code) => void copyText(code)}
						onFileReference={(path) => void openFileReference(cwd, path)}
					/>
				)
			) : null}
			{role === "user" && item.timestamp ? <MessageMeta model={model} timestamp={item.timestamp} /> : null}
		</article>
	);
});

/**
 * What a message was and when: the model and the clock time (`14:05`), as plain
 * text with no label. A sent message shows it under its bubble; a reply shows it
 * once, on the row under the turn that settled. An entry without a timestamp (an
 * optimistic pending bubble) shows nothing.
 */
function MessageMeta({ model, timestamp }: { readonly model?: string; readonly timestamp: string }) {
	const clock = clockTime(timestamp);
	return (
		<span className="message-meta" data-model={model || undefined}>
			{model ? <span className="message-meta-model">{model}</span> : null}
			<time className="message-meta-time" dateTime={timestamp}>
				{clock}
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
	model,
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
			<button
				className="message-action copy-message"
				type="button"
				title={t("copy")}
				aria-label={t("copy")}
				onClick={() => void copyText(content)}
			>
				<Icon {...LEGACY_ICONS.copy} />
			</button>
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
			{last?.timestamp && !aborted ? <MessageMeta model={model} timestamp={last.timestamp} /> : null}
		</div>
	);
}
