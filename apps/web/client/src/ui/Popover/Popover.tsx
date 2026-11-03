import {
	type ComponentPropsWithRef,
	type CSSProperties,
	cloneElement,
	type MouseEvent,
	type ReactElement,
	type ReactNode,
	type Ref,
	useId,
	useRef,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/format";
import { type DismissEvent, useDismiss } from "../hooks/useDismiss";
import { useMergedRef } from "../hooks/useMergedRef";
import styles from "./Popover.module.css";

/** Props Popover sets on its trigger; the trigger must forward them to its DOM node (a `Tooltip` does). */
export interface PopoverTriggerProps {
	readonly style?: CSSProperties;
	readonly ref?: Ref<HTMLElement>;
}

/**
 * Side of the trigger, then which edges line up: `start` = left edges, `end` =
 * right edges, none = centred on the trigger (shifted only at a viewport edge).
 * `right-start` opens a submenu beside its row, top edges aligned.
 */
export type PopoverPlacement =
	| "bottom"
	| "bottom-start"
	| "bottom-end"
	| "top"
	| "top-start"
	| "top-end"
	| "right-start";

const PLACEMENT_CLASS: Record<PopoverPlacement, string | undefined> = {
	bottom: styles.bottom,
	top: styles.top,
	"bottom-start": styles.bottomStart,
	"bottom-end": styles.bottomEnd,
	"top-start": styles.topStart,
	"top-end": styles.topEnd,
	"right-start": styles.rightStart,
};

export interface PopoverProps extends Omit<ComponentPropsWithRef<"div">, "children" | "content"> {
	readonly open: boolean;
	/** Called when an outside press or Escape asks to close. The owner flips `open`. */
	readonly onClose: (reason: "outside" | "escape") => void;
	/** The panel's content, rendered only while `open`. */
	readonly content: ReactNode;
	/** The trigger: one element that forwards `ref` and `style`, e.g. a `<button>`, an `IconButton` or a `Tooltip`. */
	readonly children: ReactElement<PopoverTriggerProps>;
	/** Default `bottom-start`. Flips to the other side when the viewport has no room. */
	readonly placement?: PopoverPlacement;
	/** Document event that dismisses; `false` disables outside dismissal. Default `pointerdown`. */
	readonly dismissOn?: DismissEvent | false;
	/** Dismiss on Escape and refocus the trigger. Default true. Turn off when a central Escape chain owns this overlay. */
	readonly closeOnEscape?: boolean;
	/** Unstyled: drop the module's surface styles and keep only the classes passed in. */
	readonly bare?: boolean;
}

/**
 * `<Popover content={panel} open onClose>{trigger}</Popover>`: renders the
 * trigger and, only while `open`, a panel next to it. Remaining div props
 * (`id`, `className`, `role`, `onKeyDown`...) go to the panel.
 *
 * The panel is portaled to `document.body`, so no scroll container clips it and
 * no ancestor's styles leak in, and follows the trigger through a unique CSS
 * `anchor-name` set inline on it (a gap of `--popover-gap`, default 4px). It
 * hides while the trigger is scrolled out of view. Presses on the trigger or
 * the panel are not outside presses.
 *
 * Clicks inside the panel stop propagating: through the portal they would
 * otherwise reach the trigger's React ancestors (a row that opens on click), and
 * a control the click removed would look like an outside press to the document.
 */
export function Popover({
	open,
	onClose,
	content,
	children,
	placement = "bottom-start",
	dismissOn = "pointerdown",
	closeOnEscape = true,
	bare = false,
	className,
	style,
	ref,
	...rest
}: PopoverProps) {
	const panel = useRef<HTMLDivElement | null>(null);
	const panelRef = useMergedRef(panel, ref);
	const trigger = useRef<HTMLElement | null>(null);
	const triggerRef = useMergedRef(trigger, children.props.ref);
	const anchorName = `--popover-${useId().replace(/[^\w-]/g, "")}`;
	useDismiss({
		enabled: open,
		insideRefs: [panel, trigger],
		event: dismissOn,
		escape: closeOnEscape,
		onDismiss: (reason) => {
			onClose(reason);
			if (reason === "escape") trigger.current?.focus();
		},
	});
	// The trigger may carry another anchor name (a tooltip anchored to it); keep both.
	const ownAnchor = children.props.style?.anchorName;
	const anchoredTrigger = cloneElement(children, {
		ref: triggerRef,
		style: { ...children.props.style, anchorName: ownAnchor ? `${ownAnchor}, ${anchorName}` : anchorName },
	});
	const onPanelClick = (event: MouseEvent<HTMLDivElement>) => {
		rest.onClick?.(event);
		event.stopPropagation();
	};
	return (
		<>
			{anchoredTrigger}
			{open
				? createPortal(
						// The panel is a container: its click handler only stops propagation (see above);
						// the controls inside are the interactive elements.
						// biome-ignore lint/a11y/noStaticElementInteractions: see above.
						// biome-ignore lint/a11y/useKeyWithClickEvents: see above.
						<div
							ref={panelRef}
							className={cx(!bare && styles.root, styles.panel, PLACEMENT_CLASS[placement], className)}
							style={{ ...style, positionAnchor: anchorName }}
							{...rest}
							onClick={onPanelClick}
						>
							{content}
						</div>,
						document.body,
					)
				: null}
		</>
	);
}
