import "./clarification.css";

import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useImeGuard } from "../../lib/ime";
import { useAppStore } from "../../state/store";
import type { ClarificationReply, ClarificationRequest } from "../../state/types";
import { Icon, IconButton } from "../../ui";
import { replyToClarification } from "../composer/actions";

export function ClarificationPanel() {
	const request = useAppStore((state) => state.current?.pendingClarifications?.[0]);
	return (
		<section className="clarification-panel" hidden={!request}>
			{request && <Questionnaire key={request.id} request={request} />}
		</section>
	);
}

function Questionnaire({ request }: { readonly request: ClarificationRequest }) {
	const t = useT();
	const ime = useImeGuard();
	const [page, setPage] = useState(0);
	const [answers, setAnswers] = useState<readonly (ClarificationReply | undefined)[]>([]);
	const [drafts, setDrafts] = useState<Readonly<Record<number, string>>>({});
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const submitting = useRef(false);
	const editor = useRef<HTMLTextAreaElement>(null);
	const question = request.questions[page];
	const last = page === request.questions.length - 1;
	const answer = answers[page];
	const draft = drafts[page] ?? (answer && "text" in answer ? answer.text : "");

	useEffect(() => {
		if (editing || question?.options.length === 0) editor.current?.focus();
	}, [editing, question]);

	if (!question) return null;
	const send = async (next: readonly ClarificationReply[], cancelled = false) => {
		if (submitting.current) return;
		submitting.current = true;
		setBusy(true);
		const sent = await replyToClarification(request, next, cancelled);
		if (!sent) {
			submitting.current = false;
			setBusy(false);
		}
	};
	const navigate = (index: number) => {
		setPage(index);
		setEditing(false);
	};
	const save = (reply: ClarificationReply) => {
		if (submitting.current) return;
		const next = request.questions.map((_, index) => (index === page ? reply : answers[index]));
		setAnswers(next);
		if (next.every((entry): entry is ClarificationReply => entry !== undefined)) {
			void send(next);
			return;
		}
		// Paging ahead is allowed; never silently submit questions the user has not answered.
		const nextPage = last ? next.indexOf(undefined) : page + 1;
		navigate(nextPage);
	};
	const confirm = () => {
		if ((editing || question.options.length === 0) && draft.trim()) save({ id: question.id, text: draft.trim() });
		else if (answer) save(answer);
	};
	const canConfirm = editing || question.options.length === 0 ? Boolean(draft.trim()) : Boolean(answer);

	return (
		<div className="clarification-card" aria-busy={busy}>
			{/*
			 * No header, no card chrome: the questionnaire reads as part of the
			 * conversation — the question text with quick-reply pills under it.
			 * Only a multi-question round shows the slim page navigation, and
			 * closing the round lives with the other footer text actions.
			 */}
			{request.questions.length > 1 ? (
				<nav className="clarification-navigation" aria-label={t("clarificationNavigation")}>
					<IconButton
						icon="chevronLeft"
						aria-label={t("clarificationPrevious")}
						disabled={page === 0 || busy}
						onClick={() => navigate(page - 1)}
					/>
					<span className="clarification-page" aria-live="polite">
						{t("clarificationPage", { current: page + 1, total: request.questions.length })}
					</span>
					<IconButton
						icon="chevronRight"
						aria-label={t("clarificationNext")}
						disabled={last || busy}
						onClick={() => navigate(page + 1)}
					/>
				</nav>
			) : null}
			<div className="clarification-body" key={page}>
				<h2 id="clarification-question">{question.question}</h2>
				{question.reason && <p className="clarification-reason">{question.reason}</p>}
				<fieldset className="clarification-options" aria-labelledby="clarification-question">
					{question.options.map((option, index) => (
						<button
							key={`${index}-${option.value}`}
							type="button"
							className="clarification-option"
							disabled={busy}
							title={option.description || undefined}
							aria-pressed={
								!editing && answer !== undefined && "optionIndex" in answer && answer.optionIndex === index
							}
							onClick={() => save({ id: question.id, optionIndex: index })}
						>
							{option.label}
						</button>
					))}
				</fieldset>
			</div>
			<footer className="clarification-footer">
				<div className="clarification-custom" hidden={!question.allowFreeform}>
					<Icon name="pencil" />
					{editing || question.options.length === 0 ? (
						<textarea
							key={page}
							ref={editor}
							rows={1}
							value={draft}
							disabled={busy}
							aria-label={t("clarificationCustom")}
							placeholder={t("clarificationCustom")}
							{...ime.handlers}
							onInputCapture={(event) => {
								const value = event.currentTarget.value;
								setDrafts((values) => ({ ...values, [page]: value }));
							}}
							onChange={(event) => setDrafts((values) => ({ ...values, [page]: event.target.value }))}
							onKeyDown={(event) => {
								if (event.key !== "Enter" || event.shiftKey || ime.isComposing(event)) return;
								event.preventDefault();
								confirm();
							}}
						/>
					) : (
						<button type="button" disabled={busy} onClick={() => setEditing(true)}>
							{draft || t("clarificationCustom")}
						</button>
					)}
				</div>
				<div className="clarification-actions">
					<button
						type="button"
						className="clarification-skip"
						disabled={busy}
						onClick={() => save({ id: question.id, skipped: true })}
					>
						{t("clarificationSkip")}
					</button>
					<button type="button" className="clarification-skip" disabled={busy} onClick={() => void send([], true)}>
						{t("clarificationClose")}
					</button>
					<button type="button" className="clarification-confirm" disabled={busy || !canConfirm} onClick={confirm}>
						{t(busy ? "clarificationSending" : last ? "clarificationSend" : "clarificationContinue")}
					</button>
				</div>
			</footer>
		</div>
	);
}
