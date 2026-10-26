import { type FormEvent, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { closeRenameSession, renameSession } from "../../state/session";
import { useAppStore } from "../../state/store";
import { Button, IconButton, Modal } from "../../ui";

/** The host stores `name.trim().slice(0, 20)` (`apps/web/src/runtime.ts`), so the field offers no more. */
const NAME_MAX_LENGTH = 20;

/**
 * `#renameSessionDialog`: name a session from the sidebar row or the
 * conversation header menu. Replaces `window.prompt`, which the desktop host
 * (Electron) does not implement. Escape belongs to the shell's central chain.
 */
export function RenameSessionDialog() {
	const target = useAppStore((state) => state.ui.renameSession);
	const dialog = useRef<HTMLElement>(null);
	const pending = target?.pending ?? false;

	// Saving disables every control in the dialog: hold focus on the dialog itself
	// instead of letting Tab walk into the page behind it.
	useEffect(() => {
		if (pending) dialog.current?.focus();
	}, [pending]);

	return (
		<Modal
			id="renameSessionDialog"
			className="rename-session-dialog"
			open={Boolean(target)}
			labelledBy="renameSessionTitle"
			onClose={closeRenameSession}
			dialogProps={{
				ref: dialog,
				"aria-busy": pending,
				tabIndex: -1,
				onKeyDown: (event) => {
					if (event.key !== "Tab") return;
					const fields = [...event.currentTarget.querySelectorAll<HTMLElement>("input, button:not(:disabled)")];
					const first = fields[0];
					const last = fields[fields.length - 1];
					if (!first || !last || first === last) {
						event.preventDefault();
						event.currentTarget.focus();
					} else if (event.shiftKey && document.activeElement === first) {
						event.preventDefault();
						last.focus();
					} else if (!event.shiftKey && document.activeElement === last) {
						event.preventDefault();
						first.focus();
					}
				},
			}}
		>
			{/* Keyed by session, so a reopened dialog starts from that session's current name. */}
			{target ? (
				<RenameSessionForm key={target.sessionId} initialName={target.name} pending={target.pending} />
			) : null}
		</Modal>
	);
}

function RenameSessionForm({ initialName, pending }: { readonly initialName: string; readonly pending: boolean }) {
	const t = useT();
	const input = useRef<HTMLInputElement>(null);
	const [name, setName] = useState(initialName);
	const wasPending = useRef(false);
	const initial = initialName.trim();

	useEffect(() => {
		const previous = document.activeElement;
		input.current?.select();
		return () => {
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
			else document.getElementById("prompt")?.focus();
		};
	}, []);

	// A refused save clears `pending`: the typed name is still there to retry.
	useEffect(() => {
		if (wasPending.current && !pending) input.current?.select();
		wasPending.current = pending;
	}, [pending]);

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed || pending || trimmed === initial) return;
		void renameSession(trimmed);
	};

	return (
		<form onSubmit={submit}>
			<header>
				<h2 id="renameSessionTitle">{t("renameSessionTitle")}</h2>
				<IconButton icon="close" aria-label={t("cancel")} disabled={pending} onClick={closeRenameSession} />
			</header>
			<input
				ref={input}
				id="renameSessionInput"
				className="rename-session-input"
				type="text"
				aria-label={t("renameSessionLabel")}
				maxLength={NAME_MAX_LENGTH}
				disabled={pending}
				value={name}
				onChange={(event) => setName(event.currentTarget.value)}
			/>
			<footer>
				<Button id="renameSessionCancel" disabled={pending} onClick={closeRenameSession}>
					{t("cancel")}
				</Button>
				<Button
					id="renameSessionConfirm"
					type="submit"
					disabled={pending || !name.trim() || name.trim() === initial}
				>
					{t("renameSessionConfirm")}
				</Button>
			</footer>
		</form>
	);
}
