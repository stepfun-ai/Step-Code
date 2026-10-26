/**
 * `#prompt`: the composer's contenteditable editor. Enter sends (IME-safe), Shift+Enter breaks the line
 * (legacy app.js 3256-3273, 3576-3583). It is contenteditable rather than a textarea so files pasted or
 * dropped from Finder / Explorer sit inline as chips (see prompt-editor.ts); everything else stays plain
 * text, with pasted rich text converted to Markdown source (see html-to-markdown.ts).
 */

import {
	type ClipboardEvent,
	type DragEvent,
	type KeyboardEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useT } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { useImeGuard } from "../../lib/ime";
import { showError } from "../../state/session";
import { getState, useAppStore } from "../../state/store";
import { addAttachments, applyLeadingCommand, uploadFile } from "./actions";
import { FileDropOverlay } from "./FileDropOverlay";
import { hasMarkdownSyntax, htmlToMarkdown } from "./html-to-markdown";
import { planInlineFormat, planLink } from "./markdown-format";
import {
	applyPromptEdit,
	formatPromptSelection,
	insertFileChip,
	insertLineBreak,
	insertTextAtCaret,
	placeCaretAtEnd,
	placeCaretAtPoint,
	promptSelection,
	promptText,
	refreshPlaceholderHint,
	setPromptText,
	tidyEmptyPrompt,
} from "./prompt-editor";

/** A drag from the file manager; text or element drags inside the page carry no `Files`. */
function draggingFiles(event: globalThis.DragEvent): boolean {
	return event.dataTransfer?.types.includes("Files") ?? false;
}

/** Image types the models accept as image content; other images are sent as files. */
const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface PromptInputProps {
	readonly promptRef: RefObject<HTMLDivElement | null>;
	/** DOM id of the editor; the bottom composer's is `prompt`. */
	readonly id?: string;
	/** Ignore the shared prompt-focus signal (the in-place edit editor manages its own). */
	readonly ignoreFocusRequest?: boolean;
	readonly disabled: boolean;
	/** Enter without Shift, outside an IME composition. */
	readonly onSubmit: () => void;
	/** Cmd/Ctrl+Enter: the steer variant of a send. Without it the chord submits like Enter. */
	readonly onSteer?: () => void;
	/** Overrides the default placeholder, e.g. the queue hints while a turn runs. */
	readonly placeholder?: string;
	/** Every edit, with the new text (the input menus follow it). */
	readonly onValueInput?: (value: string) => void;
	/** Selection/focus changes can move the caret into or out of an @path without editing it. */
	readonly onCaretChange?: () => void;
	/** Suspend @path detection until the IME commits its provisional text. */
	readonly onCompositionChange?: (composing: boolean) => void;
	/** Offered each key first; returning true means an open menu used it. */
	readonly onMenuKey?: (key: string) => boolean;
	/** Cmd/Ctrl+Shift+M: the composer swaps the editor for the rendered Markdown preview. */
	readonly onTogglePreview?: () => void;
	/**
	 * A rich paste that started the draft with real Markdown markers: the
	 * composer shows the rendered preview instead of leaving raw source on show.
	 */
	readonly onRichPaste?: () => void;
	/**
	 * Filled with the editor's file stager, so files picked elsewhere (`#attachInput` in `#plusMenu`) are staged
	 * exactly like pasted or dropped ones: images as attachments, every other file as an inline chip.
	 */
	readonly stageFilesRef?: RefObject<((files: readonly File[]) => void) | null>;
}

/** Uncontrolled: the composer reads and resets the content through the ref on send. */
export function PromptInput({
	promptRef,
	id = "prompt",
	ignoreFocusRequest = false,
	disabled,
	onSubmit,
	onSteer,
	placeholder: placeholderOverride,
	onValueInput,
	onCaretChange,
	onCompositionChange,
	onMenuKey,
	onTogglePreview,
	onRichPaste,
	stageFilesRef,
}: PromptInputProps) {
	const t = useT();
	const ime = useImeGuard();
	const focusRequest = useAppStore((state) => state.ui.promptFocusRequest);
	useEffect(() => {
		if (focusRequest && !ignoreFocusRequest) promptRef.current?.focus();
	}, [focusRequest, promptRef, ignoreFocusRequest]);
	// Rewrite: a message's text comes back into the prompt for editing.
	const draftRequest = useAppStore((state) => state.ui.promptDraftRequest);
	useEffect(() => {
		const root = promptRef.current;
		if (!root || !draftRequest) return;
		setPromptText(root, draftRequest.text);
		root.focus();
		onValueInput?.(draftRequest.text);
	}, [draftRequest, promptRef, onValueInput]);
	useEffect(() => {
		const root = promptRef.current;
		if (!root) return;
		// Cmd/Ctrl+B, I, U and friends would add markup the message cannot carry.
		const blockFormatting = (event: InputEvent) => {
			if (event.inputType.startsWith("format")) event.preventDefault();
		};
		root.addEventListener("beforeinput", blockFormatting);
		return () => root.removeEventListener("beforeinput", blockFormatting);
	}, [promptRef]);

	useEffect(() => {
		if (!onCaretChange) return;
		document.addEventListener("selectionchange", onCaretChange);
		return () => document.removeEventListener("selectionchange", onCaretChange);
	}, [onCaretChange]);

	const changed = useCallback(() => {
		const root = promptRef.current;
		if (!root) return;
		// A completed leading command becomes its chip before anyone reads the prompt.
		applyLeadingCommand(root);
		tidyEmptyPrompt(root);
		refreshPlaceholderHint(root);
		onValueInput?.(promptText(root));
	}, [promptRef, onValueInput]);

	/** Images become attachments (sent as image content); every other file an inline chip uploaded to the host. */
	const stageFiles = useCallback(
		(files: readonly File[]) => {
			const root = promptRef.current;
			if (!root) return;
			const images = files.filter((file) => MODEL_IMAGE_TYPES.has(file.type));
			if (images.length) void addAttachments(images);
			for (const file of files) {
				if (MODEL_IMAGE_TYPES.has(file.type)) continue;
				insertFileChip(root, file.name, uploadFile(file), (error) => {
					showError(t("fileUploadFailed", { name: file.name, reason: errorMessage(error) }));
					changed();
				});
			}
			changed();
		},
		[promptRef, changed, t],
	);

	/*
	 * Files dragged anywhere over the window show `.file-drop-overlay`. It
	 * ignores the pointer, so a drop on `#prompt` still reaches `onDrop` below
	 * and lands at the pointer; a drop anywhere else lands at the prompt's end.
	 * Every file drop is cancelled: the browser default opens the file in place
	 * of the app. dragenter/dragleave fire for each element crossed, hence the
	 * depth count.
	 */
	const [dropActive, setDropActive] = useState(false);
	const disabledRef = useRef(disabled);
	disabledRef.current = disabled;
	const stageRef = useRef(stageFiles);
	stageRef.current = stageFiles;
	useEffect(() => {
		if (!stageFilesRef) return;
		// Chips land at the caret the prompt kept while the menu was open, or at the end.
		stageFilesRef.current = (files) => {
			const root = promptRef.current;
			if (!root || !files.length || disabledRef.current) return;
			stageRef.current(files);
			root.focus();
		};
		return () => {
			stageFilesRef.current = null;
		};
	}, [stageFilesRef, promptRef]);
	useEffect(() => {
		let depth = 0;
		const accepting = () => !disabledRef.current && !getState().ui.loginRequired;
		const reset = () => {
			depth = 0;
			setDropActive(false);
		};
		const onEnter = (event: globalThis.DragEvent) => {
			if (!draggingFiles(event)) return;
			depth += 1;
			if (accepting()) setDropActive(true);
		};
		const onLeave = (event: globalThis.DragEvent) => {
			if (!draggingFiles(event)) return;
			depth = Math.max(0, depth - 1);
			if (!depth) setDropActive(false);
		};
		const onOver = (event: globalThis.DragEvent) => {
			if (!draggingFiles(event)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = accepting() ? "copy" : "none";
		};
		const onDropAnywhere = (event: globalThis.DragEvent) => {
			if (!draggingFiles(event)) return;
			reset();
			// `#prompt` handled it (React's root listener runs before this window listener).
			if (event.defaultPrevented) return;
			event.preventDefault();
			const root = promptRef.current;
			const files = [...(event.dataTransfer?.files ?? [])];
			if (!root || !files.length || !accepting()) return;
			root.focus();
			placeCaretAtEnd(root);
			stageRef.current(files);
		};
		window.addEventListener("dragenter", onEnter);
		window.addEventListener("dragleave", onLeave);
		window.addEventListener("dragover", onOver);
		window.addEventListener("drop", onDropAnywhere);
		window.addEventListener("dragend", reset);
		return () => {
			window.removeEventListener("dragenter", onEnter);
			window.removeEventListener("dragleave", onLeave);
			window.removeEventListener("dragover", onOver);
			window.removeEventListener("drop", onDropAnywhere);
			window.removeEventListener("dragend", reset);
		};
	}, [promptRef]);

	const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
		const root = promptRef.current;
		if (!root) return;
		const data = event.clipboardData;
		const files = [...data.files];
		const html = data.getData("text/html");
		const plain = data.getData("text/plain");
		// Only text and chips enter the editor: markup is converted, never inserted as HTML.
		event.preventDefault();
		// Office documents and spreadsheets pair their rich text with a rendered
		// image file; the user meant the text. A screenshot, an image copied from a
		// page, or files copied in Finder / Explorer have no such pair.
		const officeCopy = files.length > 0 && Boolean(html) && Boolean(plain.trim());
		if (officeCopy) {
			insertTextAtCaret(root, plain);
			return;
		}
		if (files.length) {
			stageFiles(files);
			return;
		}
		// A rich copy keeps its emphasis, lists, code and links as Markdown source
		// (see html-to-markdown.ts); anything unconvertible falls back to plain text.
		let markdown: string | null = null;
		if (html) {
			try {
				markdown = htmlToMarkdown(html);
			} catch {
				markdown = null;
			}
		}
		const emptyBefore = !promptText(root).trim();
		insertTextAtCaret(root, markdown ?? plain);
		// A rich paste that starts a draft shows its render instead of raw markers;
		// typing into an existing draft is never interrupted.
		if (markdown && emptyBefore && hasMarkdownSyntax(markdown)) onRichPaste?.();
	};

	const onDrop = (event: DragEvent<HTMLDivElement>) => {
		const root = promptRef.current;
		const files = [...event.dataTransfer.files];
		// Dropped text keeps the browser's default; the serialiser reads any markup it adds as text.
		if (!root || !files.length || disabled) return;
		event.preventDefault();
		root.focus();
		placeCaretAtPoint(root, event.clientX, event.clientY);
		stageFiles(files);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.nativeEvent.keyCode === 229 || ime.isComposing(event)) return;
		if (!event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && onMenuKey?.(event.key)) {
			event.preventDefault();
			return;
		}
		const mod = event.metaKey || event.ctrlKey;
		const key = event.key.toLowerCase();
		// Cmd/Ctrl+Shift+M swaps in the rendered Markdown preview (see `Composer`).
		if (mod && event.shiftKey && !event.altKey && key === "m" && onTogglePreview) {
			event.preventDefault();
			onTogglePreview();
			return;
		}
		if (mod && !event.shiftKey && !event.altKey) {
			const marker = key === "b" ? "**" : key === "i" ? "*" : key === "e" ? "`" : null;
			if (marker) {
				// The browser's own rich-text formatting stays blocked (see `beforeinput`);
				// the shortcut writes Markdown markers into the plain text instead.
				event.preventDefault();
				const root = promptRef.current;
				if (root) formatPromptSelection(root, (range) => planInlineFormat(range, marker));
				return;
			}
			if (key === "k") {
				// A bare Cmd/Ctrl+K remains the global search; a link needs a selection.
				const root = promptRef.current;
				const range = root ? promptSelection(root) : null;
				if (!root || !range || range.start === range.end) return;
				const edit = planLink(range);
				if (!edit) return;
				event.preventDefault();
				applyPromptEdit(root, edit);
				return;
			}
		}
		if (event.key !== "Enter") return;
		event.preventDefault();
		if (event.shiftKey) {
			if (promptRef.current) insertLineBreak(promptRef.current);
			return;
		}
		if ((event.metaKey || event.ctrlKey) && onSteer) onSteer();
		else onSubmit();
	};

	const placeholder = placeholderOverride ?? t("messagePlaceholder");
	return (
		<>
			<FileDropOverlay open={dropActive} />
			{/* biome-ignore lint/a11y/useSemanticElements: a textarea cannot hold the inline file chips; this is a contenteditable textbox. */}
			<div
				id={id}
				ref={promptRef}
				className="prompt-editor"
				role="textbox"
				aria-multiline="true"
				aria-label={placeholder}
				aria-placeholder={placeholder}
				aria-disabled={disabled || undefined}
				data-placeholder={placeholder}
				contentEditable={!disabled}
				tabIndex={disabled ? -1 : 0}
				onFocus={onCaretChange}
				onBlur={onCaretChange}
				onCompositionStart={() => {
					ime.handlers.onCompositionStart();
					onCompositionChange?.(true);
				}}
				onCompositionEnd={() => {
					ime.handlers.onCompositionEnd();
					onCompositionChange?.(false);
					// Chrome fires the composition's last input before compositionend.
					changed();
				}}
				onInput={(event) => {
					// Mid-composition text is provisional, and tidying the DOM would break the IME.
					if (!(event.nativeEvent as InputEvent).isComposing) changed();
				}}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
				onDrop={onDrop}
			/>
		</>
	);
}
