import type { ComponentPropsWithRef } from "react";
import { cx } from "../../lib/format";
import { Icon, type IconName } from "../Icon/Icon";
import { IconButton } from "../IconButton/IconButton";
import styles from "./Toast.module.css";

export type ToastTone = "danger" | "neutral" | "success";

/** Success and danger lead with a status icon; neutral shows text only. */
const TONE_ICONS: Partial<Record<ToastTone, IconName>> = { success: "circleCheck", danger: "circleX" };

export interface ToastProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
	/** Text to show; null or "" hides the toast (it stays mounted). */
	readonly message: string | null | undefined;
	/** Bold headline above the message. */
	readonly title?: string;
	readonly tone?: ToastTone;
	/** Label of an optional link-styled button after the message (e.g. "Undo", "View"). */
	readonly actionLabel?: string;
	/** Called when the action button is pressed; the action shows only with both label and handler. */
	readonly onAction?: () => void;
	/** Renders the dismiss button; without it the toast only self-dismisses. */
	readonly onClose?: () => void;
	/** Accessible name for the dismiss button. */
	readonly closeLabel?: string;
}

/**
 * `role="alert"` toast with `data-tone`, as the legacy `#errorToast`: an inverse
 * dark card fixed at the top centre of the window (a caller may move it with an
 * inline `left` / `top` style; it stays centred on `left`). Success and danger
 * lead with a status icon; a title renders as a headline above the detail; an
 * optional action renders as a link-styled `button.toast-action`; an optional
 * dismiss button closes it. Timing is the caller's job.
 */
export function Toast({
	message,
	title,
	tone = "danger",
	actionLabel,
	onAction,
	onClose,
	closeLabel,
	className,
	...rest
}: ToastProps) {
	const icon = TONE_ICONS[tone];
	return (
		<div className={cx(styles.root, className)} role="alert" data-tone={tone} hidden={!message && !title} {...rest}>
			{icon ? <Icon name={icon} size="md" className={cx(styles.icon, "toast-icon")} /> : null}
			<div className={styles.copy}>
				{title ? <strong className={styles.title}>{title}</strong> : null}
				{message ? <span className={styles.message}>{message}</span> : null}
				{actionLabel && onAction ? (
					<button type="button" className={cx(styles.action, "toast-action")} onClick={onAction}>
						{actionLabel}
					</button>
				) : null}
			</div>
			{onClose ? (
				<IconButton
					className={cx(styles.close, "toast-close")}
					icon="close"
					iconSize="xs"
					aria-label={closeLabel}
					onClick={onClose}
				/>
			) : null}
		</div>
	);
}
