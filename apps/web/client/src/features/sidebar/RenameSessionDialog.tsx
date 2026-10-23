import { type FormEvent, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { closeRenameSession, renameSession } from "../../state/session";
import { useAppStore } from "../../state/store";
import { Button, IconButton, Modal } from "../../ui";

/**
 * `#renameSessionDialog`: name a session from the sidebar row or the
 * conversation header menu. Replaces `window.prompt`, which the desktop host
 * (Electron) does not implement. Escape belongs to the shell's central chain.
 */
export function RenameSessionDialog() {
	const target = useAppStore((state) => state.ui.renameSession);
	return (
		<Modal
			id="renameSessionDialog"
			className="rename-session-dialog"
			open={Boolean(target)}
			labelledBy="renameSessionTitle"
			onClose={closeRenameSession}
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

	useEffect(() => {
		const previous = document.activeElement;
		input.current?.select();
		return () => {
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
			else document.getElementById("prompt")?.focus();
		};
	}, []);

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		void renameSession(name);
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
				disabled={pending}
				value={name}
				onChange={(event) => setName(event.currentTarget.value)}
			/>
			<footer>
				<Button id="renameSessionCancel" disabled={pending} onClick={closeRenameSession}>
					{t("cancel")}
				</Button>
				<Button id="renameSessionConfirm" type="submit" disabled={pending || !name.trim()}>
					{t("renameSessionConfirm")}
				</Button>
			</footer>
		</form>
	);
}
