import type { ComponentPropsWithRef } from "react";
import { cx } from "../../lib/format";
import { Icon, type IconName } from "../Icon/Icon";
import styles from "./Toast.module.css";

export type ToastTone = "danger" | "neutral" | "success";

export interface ToastProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
	/** Text to show; null or "" hides the toast (it stays mounted). */
	readonly message: string | null | undefined;
	readonly tone?: ToastTone;
	/** Label of an optional link-styled button after the message (e.g. "Undo", "View"). */
	readonly actionLabel?: string;
	/** Called when the action button is pressed; the action shows only with both label and handler. */
	readonly onAction?: () => void;
}

const TONE_ICONS: Partial<Record<ToastTone, IconName>> = { success: "circleCheck", danger: "circleX" };

/**
 * `role="alert"` toast with `data-tone`, as the legacy `#errorToast`: an inverse
 * dark pill fixed at the top centre of the window (a caller may move it with an
 * inline `left` / `top` style; it stays centred on `left`). Success and danger
 * lead with a status icon; an optional action renders as a link-styled
 * `button.toast-action`. Timing is the caller's job.
 */
export function Toast({ message, tone = "danger", actionLabel, onAction, className, ...rest }: ToastProps) {
	const icon = TONE_ICONS[tone];
	return (
		<div className={cx(styles.root, className)} role="alert" data-tone={tone} hidden={!message} {...rest}>
			{icon ? <Icon name={icon} size="md" className={styles.icon} /> : null}
			<span className={styles.message}>{message ?? ""}</span>
			{actionLabel && onAction ? (
				<button type="button" className={cx(styles.action, "toast-action")} onClick={onAction}>
					{actionLabel}
				</button>
			) : null}
		</div>
	);
}
