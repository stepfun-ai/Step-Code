import type { ComponentPropsWithRef, MouseEvent, ReactNode } from "react";
import { cx } from "../../lib/format";
import styles from "./MarkdownView.module.css";
import { MarkdownContent, type MarkdownLabels } from "./markdown-content";

export type { MarkdownLabels } from "./markdown-content";

export interface MarkdownViewProps extends Omit<ComponentPropsWithRef<"div">, "children" | "dangerouslySetInnerHTML"> {
	/** Markdown source; rendered by Streamdown (see markdown-content.ts for what is allowed through). */
	readonly source: string;
	readonly labels: MarkdownLabels;
	/** The text is still streaming in: unfinished syntax is completed, highlighting waits. */
	readonly streaming?: boolean;
	/** Render local file references as buttons that call `onFileReference`. */
	readonly localFiles?: boolean;
	/** Names behind the `\u0002N\u0002` attached-file markers in `source`. */
	readonly fileNames?: readonly string[];
	/** Replaces attached-file marker N. */
	readonly renderFile?: (index: number) => ReactNode;
	/** Shown inline before the first line of the text (a command or skill badge). */
	readonly lead?: ReactNode;
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
 * Renders Markdown and opens local file references by event delegation. Give
 * it the wrapper classes, e.g. `className="message-body"` or
 * `"preview-markdown message-body"`.
 */
export function MarkdownView({
	source,
	labels,
	streaming,
	localFiles,
	fileNames,
	renderFile,
	lead,
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
		if (!onFileReference || !(target instanceof Element)) return;
		const reference = target.closest<HTMLButtonElement>("button.md-file-reference[data-file-path]");
		if (reference && event.currentTarget.contains(reference)) {
			event.preventDefault();
			onFileReference(reference.dataset.filePath ?? "");
		}
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: delegates clicks of the file-reference buttons inside the rendered Markdown.
		// biome-ignore lint/a11y/useKeyWithClickEvents: the delegated targets are buttons, which raise click from the keyboard.
		<div className={cx(styles.root, className)} onClick={handleClick} {...rest}>
			{lead}
			<MarkdownContent
				source={source}
				labels={labels}
				streaming={streaming}
				localFiles={localFiles}
				fileNames={fileNames}
				renderFile={renderFile}
				onCopyCode={onCopyCode}
				copiedLabel={copiedLabel}
			/>
		</div>
	);
}
