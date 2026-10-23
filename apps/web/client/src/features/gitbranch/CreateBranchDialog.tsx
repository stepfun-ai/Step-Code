import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { Icon, Modal } from "../../ui";

/**
 * `#branchCreateDialog`: name a new branch, created at the current HEAD and
 * switched to. A plain dialog rather than an inline field in the popover,
 * because the popover closes on outside clicks and a name typed over the
 * conversation is easy to lose.
 *
 * Portaled to `<body>`: the branch pill lives inside `form#composer`, and a
 * form nested in a form makes the browser submit the outer one natively (a
 * page navigation). React still bubbles the portaled `submit` up its own tree
 * to the composer's handler, so the handler stops it here.
 *
 * The name is validated by git on submit; this only refuses an empty one, so
 * the message the user sees is git's own rule.
 */
export function CreateBranchDialog({
	open,
	pending,
	error,
	currentBranch,
	onClose,
	onSubmit,
}: {
	readonly open: boolean;
	readonly pending: boolean;
	/** Why the last create was refused; shown under the name until the next attempt. */
	readonly error: string | null;
	readonly currentBranch: string;
	readonly onClose: () => void;
	readonly onSubmit: (name: string) => void;
}) {
	const t = useT();
	const input = useRef<HTMLInputElement | null>(null);
	const [name, setName] = useState("");
	// A reopened dialog starts empty, and a close never leaves a half-typed name behind.
	useEffect(() => {
		if (open) input.current?.focus();
		else setName("");
	}, [open]);
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		// Without this the composer's onSubmit would also run and send the prompt.
		event.stopPropagation();
		const trimmed = name.trim();
		if (trimmed && !pending) onSubmit(trimmed);
	};
	return createPortal(
		<Modal
			open={open}
			id="branchCreateDialog"
			overlayClassName="branch-dialog-overlay"
			className="branch-dialog"
			labelledBy="branchCreateTitle"
			onClose={pending ? undefined : onClose}
		>
			<form onSubmit={submit}>
				<header className="branch-dialog-header">
					<h2 id="branchCreateTitle">{t("branchCreateTitle")}</h2>
					<p>{t("branchCreateDescription", { name: currentBranch })}</p>
				</header>
				<label className="branch-dialog-field" htmlFor="branchCreateInput">
					<span>{t("branchCreateNameLabel")}</span>
					<input
						ref={input}
						id="branchCreateInput"
						className="branch-dialog-input"
						type="text"
						disabled={pending}
						value={name}
						placeholder={t("branchCreatePlaceholder")}
						onChange={(event) => setName(event.currentTarget.value)}
					/>
				</label>
				{error ? (
					<p className="branch-failure" id="branchCreateError" role="alert">
						{error}
					</p>
				) : null}
				<footer className="branch-dialog-footer">
					<button className="branch-dialog-cancel" type="button" disabled={pending} onClick={onClose}>
						{t("cancel")}
					</button>
					<button className="branch-dialog-submit" type="submit" disabled={pending || !name.trim()}>
						{pending ? <Icon name="refresh" size="sm" className="branch-dialog-spinner" /> : null}
						<span>{t("branchCreateConfirm")}</span>
					</button>
				</footer>
			</form>
		</Modal>,
		document.body,
	);
}
