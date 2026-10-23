/**
 * `#textInputDialog`: a kernel `ui.input` prompt the host relayed
 * (`apps/web/src/text-input.ts`). Today that is a step inside `/feedback`;
 * other commands that ask for text use the same dialog.
 *
 * The kernel owns the title and placeholder, and interprets the answer: an
 * empty submission is a real answer, while dismissing (Escape, the close
 * button) is what "cancelled" means. Mounted by App.tsx next to the other
 * modals; Escape belongs to the shell's central chain like every other overlay.
 */

import "./text-input-dialog.css";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import type { TextInputRequest } from "../../state/types";
import { Button, IconButton, Modal } from "../../ui";
import { answerTextInput, pendingTextInput } from "./actions";

export function TextInputDialog() {
	const request = useAppStore((state) => pendingTextInput(state));
	return (
		<Modal id="textInputDialog" className="text-input-dialog" open={Boolean(request)} labelledBy="textInputTitle">
			{request ? <TextInputBody key={request.id} request={request} /> : null}
		</Modal>
	);
}

function TextInputBody({ request }: { readonly request: TextInputRequest }) {
	const t = useT();
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const field = useRef<HTMLTextAreaElement>(null);
	// Kernel titles read "Title" or "Title\n\nmessage"; the message is the hint.
	const [title = request.title, ...message] = request.title.split("\n\n");

	useEffect(() => {
		const previous = document.activeElement;
		field.current?.focus();
		return () => {
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
			else document.getElementById("prompt")?.focus();
		};
	}, []);

	const submit = async (answer: string | undefined) => {
		if (busy) return;
		setBusy(true);
		if (!(await answerTextInput(request, answer))) setBusy(false);
	};

	// Enter submits, Shift+Enter writes a newline: the prompt is usually one value.
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void submit(value);
		}
	};

	return (
		<>
			<header>
				<h2 id="textInputTitle">{title}</h2>
				<IconButton
					icon="close"
					aria-label={t("selectionDismiss")}
					disabled={busy}
					onClick={() => void submit(undefined)}
				/>
			</header>
			{message.length ? (
				<p id="textInputMessage" className="text-input-message">
					{message.join("\n\n")}
				</p>
			) : null}
			<textarea
				id="textInputField"
				className="text-input-field"
				ref={field}
				rows={4}
				value={value}
				placeholder={request.placeholder}
				aria-labelledby="textInputTitle"
				disabled={busy}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={onKeyDown}
			/>
			<footer>
				<Button id="textInputCancel" disabled={busy} onClick={() => void submit(undefined)}>
					{t("cancel")}
				</Button>
				<Button id="textInputConfirm" disabled={busy} onClick={() => void submit(value)}>
					{t("selectionConfirm")}
				</Button>
			</footer>
		</>
	);
}
