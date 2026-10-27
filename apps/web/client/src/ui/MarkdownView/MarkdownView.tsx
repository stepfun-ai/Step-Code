import type { ComponentPropsWithRef, MouseEvent } from "react";
import { cx } from "../../lib/format";
import { COPIED_FEEDBACK_MS } from "../hooks/useCopiedFlag";
import styles from "./MarkdownView.module.css";

export interface MarkdownViewProps extends Omit<ComponentPropsWithRef<"div">, "children" | "dangerouslySetInnerHTML"> {
	/** HTML from lib/markdown `renderMarkdown` (already escaped). */
	readonly html: string;
	/**
	 * A `.copy-code` button inside a `.code-block` was clicked; receives that block's code text.
	 * Unless it resolves `false`, the button shows `data-copied` and `copiedLabel` for a moment.
	 */
	readonly onCopyCode?: (code: string) => Promise<boolean> | undefined;
	readonly copiedLabel?: string;
	/** A local reference rendered with `localFiles` enabled, never a raw file URL. */
	readonly onFileReference?: (path: string) => void;
}

/**
 * Renders Markdown HTML and handles the code blocks' copy buttons by event
 * delegation (legacy `wireCopyActions`). Give it the legacy wrapper classes,
 * e.g. `className="message-body"` or `"preview-markdown message-body"`.
 * The HTML is trusted only because renderMarkdown escapes all source text
 * before adding its own tags; never pass HTML from another source.
 */
export function MarkdownView({
	html,
	onCopyCode,
	copiedLabel,
	onFileReference,
	className,
	onClick,
	...rest
}: MarkdownViewProps) {
	const handleClick = (event: MouseEvent<HTMLDivElement>) => {
		onClick?.(event);
		const target = event.target;
		if (onFileReference && target instanceof Element) {
			const reference = target.closest<HTMLButtonElement>("button.md-file-reference[data-file-path]");
			if (reference && event.currentTarget.contains(reference)) {
				event.preventDefault();
				onFileReference(reference.dataset.filePath ?? "");
				return;
			}
		}
		if (!onCopyCode || !(target instanceof Element)) return;
		const button = target.closest<HTMLElement>(".copy-code");
		if (!button || !event.currentTarget.contains(button)) return;
		void Promise.resolve(onCopyCode(button.closest(".code-block")?.querySelector("code")?.textContent ?? "")).then(
			(ok) => {
				// The HTML is not React's: flag the button itself, and leave a running confirmation alone.
				if (ok === false || button.hasAttribute("data-copied")) return;
				const label = button.textContent;
				button.dataset.copied = "";
				if (copiedLabel) button.textContent = copiedLabel;
				setTimeout(() => {
					delete button.dataset.copied;
					button.textContent = label;
				}, COPIED_FEEDBACK_MS);
			},
		);
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: delegates clicks of the copy buttons inside the rendered HTML.
		// biome-ignore lint/a11y/useKeyWithClickEvents: the delegated targets are buttons, which raise click from the keyboard.
		<div
			className={cx(styles.root, className)}
			onClick={handleClick}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown output (legacy innerHTML contract); all source text is escaped first.
			dangerouslySetInnerHTML={{ __html: html }}
			{...rest}
		/>
	);
}
