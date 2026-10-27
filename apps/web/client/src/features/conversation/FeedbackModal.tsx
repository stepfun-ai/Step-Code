import { useEffect, useRef } from "react";
import { useT } from "../../i18n";
import { formatBytes } from "../../lib/format";
import { IconButton, Modal } from "../../ui";
import {
	closeFeedback,
	FEEDBACK_TOPIC_LABELS,
	FEEDBACK_TOPICS,
	type Sentiment,
	setFeedbackComment,
	setFeedbackSentiment,
	submitFeedback,
	toggleFeedbackTopic,
	useFeedbackState,
} from "./feedback";

const SENTIMENTS: readonly { readonly value: Sentiment; readonly labelKey: "feedbackGood" | "feedbackBad" }[] = [
	{ value: "up", labelKey: "feedbackGood" },
	{ value: "down", labelKey: "feedbackBad" },
];

/**
 * `#feedbackModal` (legacy index.html 1116-1157; app.js 2128-2185, 3390-3397):
 * sentiment, topic chips, a free-text box and one submit button. The vote
 * buttons open it with a sentiment already picked; `/feedback` opens it neutral,
 * so the same dialog serves both entries. Closes on the close button, a backdrop
 * click or Escape.
 *
 * It is also the consent page: `#feedbackAttachments` names what the host
 * prepared, because a report that cannot be investigated is one the user was
 * never told they were sending.
 */
export function FeedbackModal() {
	const t = useT();
	const feedback = useFeedbackState();
	const commentRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (!feedback.openSeq) return;
		const frame = requestAnimationFrame(() => commentRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [feedback.openSeq]);
	return (
		<Modal
			open={feedback.open}
			onClose={closeFeedback}
			id="feedbackModal"
			overlayClassName="feedback-overlay"
			className="feedback-dialog"
			labelledBy="feedbackTitle"
			closeOnEscape
		>
			<header>
				<h2 id="feedbackTitle">{t("submitFeedback")}</h2>
				<IconButton id="feedbackClose" icon="close-sm" title="关闭" aria-label="关闭" onClick={closeFeedback} />
			</header>
			{/* biome-ignore lint/a11y/useSemanticElements: legacy markup is div[role=group]; a fieldset would change the chip layout. */}
			<div className="feedback-topics" id="feedbackSentiments" role="group" aria-label={t("submitFeedback")}>
				{SENTIMENTS.map((sentiment) => (
					<button
						key={sentiment.value}
						className="feedback-topic"
						type="button"
						data-sentiment={sentiment.value}
						aria-pressed={feedback.sentiment === sentiment.value}
						onClick={() => setFeedbackSentiment(sentiment.value)}
					>
						{t(sentiment.labelKey)}
					</button>
				))}
			</div>
			{/* biome-ignore lint/a11y/useSemanticElements: legacy markup is div[role=group]; a fieldset would change the chip layout. */}
			<div className="feedback-topics" id="feedbackTopics" role="group" aria-label="反馈主题">
				{FEEDBACK_TOPICS.map((topic) => {
					const key = `feedbackTopic.${topic}`;
					const label = t(key) === key ? FEEDBACK_TOPIC_LABELS[topic] : t(key);
					return (
						<button
							key={topic}
							className="feedback-topic"
							type="button"
							aria-pressed={feedback.topic === topic}
							onClick={() => toggleFeedbackTopic(topic)}
						>
							{label}
						</button>
					);
				})}
			</div>
			<textarea
				id="feedbackComment"
				ref={commentRef}
				rows={5}
				placeholder={t("feedbackCommentPlaceholder")}
				value={feedback.comment}
				onChange={(event) => setFeedbackComment(event.target.value)}
			/>
			<FeedbackAttachments />
			<button
				className="feedback-submit"
				id="feedbackSubmit"
				type="button"
				// The evidence list is what the user consents to. Before it arrives the
				// report would be prepared by the host unseen, so wait for it — unless
				// the preview failed, where submitting is still the user's choice.
				disabled={feedback.submitting || feedback.sentiment === null || (!feedback.draft && !feedback.previewError)}
				onClick={() => void submitFeedback()}
			>
				{t("submit")}
			</button>
		</Modal>
	);
}

/**
 * `.feedback-attachments`: what the host prepared for this report.
 *
 * The kernel decides the contents and redacts them; the host only reports them,
 * so the list is built from the prepared evidence rather than from a promise of
 * what might be attached.
 */
function FeedbackAttachments() {
	const t = useT();
	const feedback = useFeedbackState();
	const draft = feedback.draft;
	if (!draft) {
		return (
			<p className="feedback-attachments" id="feedbackAttachments">
				{feedback.previewError
					? t("feedbackPreviewFailed", { reason: feedback.previewError })
					: t("feedbackPreparing")}
			</p>
		);
	}
	const preview = draft.preview;
	const total = preview.archive?.reduce((sum, file) => sum + file.bytes, 0) ?? 0;
	return (
		<div className="feedback-attachments" id="feedbackAttachments">
			<p className="feedback-attachments-title">{t("feedbackAttachmentsTitle")}</p>
			<ul className="feedback-attachments-list">
				{preview.archive ? (
					<li id="feedbackArchive">
						<span>{t("feedbackArchive")}</span>
						<small>{formatBytes(total)}</small>
					</li>
				) : null}
				{preview.diagnostics ? (
					<li id="feedbackDiagnostics">
						<span>{t("feedbackDiagnostics")}</span>
					</li>
				) : null}
				{preview.summary ? (
					<li id="feedbackSummary">
						<span>{t("feedbackSummary")}</span>
					</li>
				) : null}
			</ul>
			{preview.archive?.map((file) => (
				<p className="feedback-attachments-file" key={file.name}>
					<code>{file.name}</code>
					<small>{formatBytes(file.bytes)}</small>
					{file.note ? <em>{file.note}</em> : null}
				</p>
			))}
			{preview.archiveNote ? <p className="feedback-attachments-note">{preview.archiveNote}</p> : null}
			<p className="feedback-attachments-identity">
				{t("feedbackIdentity", { version: preview.version, channel: preview.channel })}
			</p>
		</div>
	);
}
